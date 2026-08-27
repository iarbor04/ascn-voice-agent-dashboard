import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const port = 3138;
const baseUrl = `http://127.0.0.1:${port}`;
const authorization = `Basic ${Buffer.from("admin:test-admin-password").toString("base64")}`;
const gatewayAuthorization = "Bearer test-gateway-to-app-key-6e02346f";
const externalCallAuthorization = "Bearer test-external-call-key-df715d55";
const collisionTenantId = "11111111-1111-4111-8111-111111111111";
const collisionTenantEmail = "sip-collision@example.test";
const collisionTenantPassword = "test-collision-password";
const collisionTenantSalt = "7b2452db48dfef53ef51f391235ac283";
let server;
let dataDirectory;
let serverOutput = "";

async function databaseTestQuery(query, values = []) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(query, values);
  } finally {
    await client.end();
  }
}

const legacyStore = {
  agents: [{
    id: "legacy-agent", name: "Старый агент", description: "", provider: "xai", model: "grok-voice-think-fast-2.0",
    instructions: "Ты продавец.", variables: [], tools: [], synthesisEnabled: true, voice: "xai_sal", role: "",
    speed: 1, recognitionLanguage: "auto", vadEnabled: true, vadThreshold: 0.5, silenceDurationMs: 400,
    speaksFirst: true, firstMessage: "Здравствуйте!", active: true,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  }],
  settings: {},
};

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to the test PostgreSQL service");
  assert.ok(process.env.REDIS_URL, "REDIS_URL must point to the test Redis service");
  dataDirectory = await mkdtemp(join(tmpdir(), "ascn-voice-test-"));
  await writeFile(join(dataDirectory, "voice-agents.json"), JSON.stringify(legacyStore), { encoding: "utf8", mode: 0o600 });
  await writeFile(join(dataDirectory, "users.json"), JSON.stringify({
    users: [{
      id: collisionTenantId,
      email: collisionTenantEmail,
      passwordHash: scryptSync(collisionTenantPassword, collisionTenantSalt, 64).toString("hex"),
      salt: collisionTenantSalt,
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
    sessions: [],
  }), { encoding: "utf8", mode: 0o600 });
  server = spawn("npm", ["start", "--", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      LEGACY_DATA_DIR: dataDirectory,
      ASTERISK_CONFIG_DIR: join(dataDirectory, "asterisk"),
      GATEWAY_APP_KEY: gatewayAuthorization.slice("Bearer ".length),
      APP_GATEWAY_KEY: "test-app-to-gateway-key-20c37b1a",
      BROWSER_TOKEN_SECRET: "test-browser-token-secret-7c7a6103",
      EXTERNAL_CALL_API_KEY: externalCallAuthorization.slice("Bearer ".length),
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "test-admin-password",
      TRUST_PROXY: "false",
      ALLOW_PUBLIC_REGISTRATION: "true",
      CAMPAIGN_SCHEDULER_ENABLED: "false",
      DIRECT_SIP_RESERVATIONS: JSON.stringify({
        default: ["212.53.40.1"],
        [collisionTenantId]: ["212.53.40.1"],
      }),
    },
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return; } catch { /* Server or its stateful dependencies are still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Production server did not start:\n${serverOutput}`);
});
after(async () => {
  if (server?.pid && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try {
      if (process.platform === "win32") server.kill("SIGTERM");
      else process.kill(-server.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) {
      try {
        if (process.platform === "win32") server.kill("SIGKILL");
        else process.kill(-server.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await exited;
    }
  }
  server?.stdout?.destroy();
  server?.stderr?.destroy();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test("renders the standalone voice dashboard without messaging products", async () => {
  const response = await fetch(baseUrl, { headers: { authorization } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ASCN\.AI Voice/);
  assert.match(html, /Голосовые агенты/);
  assert.match(html, /Звонки/);
  assert.doesNotMatch(html, /Рассылки|Автоцепочки|WhatsApp|Telegram/);
});

test("protects the dashboard", async () => {
  // Человека без входа ведём на страницу входа, а не в браузерное окно Basic.
  const page = await fetch(baseUrl, { redirect: "manual" });
  assert.ok([302, 307].includes(page.status), `ожидали редирект, получили ${page.status}`);
  assert.match(page.headers.get("location") || "", /\/login/);
  // API без входа отвечает 401 как раньше.
  const api = await fetch(`${baseUrl}/api/voice/agents`);
  assert.equal(api.status, 401);
  // Явный Basic-клиент вроде curl получает прежний вызов пароля.
  const basic = await fetch(baseUrl, { headers: { authorization: "Basic bm9wZTpub3Bl" } });
  assert.equal(basic.status, 401);
  assert.match(basic.headers.get("www-authenticate") || "", /ASCN Voice/);
});

test("login form accepts the service admin username without an email @ sign", async () => {
  const response = await fetch(`${baseUrl}/login`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Логин или почта/);
  assert.match(html, /autocomplete="username"/i);
  assert.doesNotMatch(html, /type="email"/i);
});

test("keeps the public health check read-only", async () => {
  const callId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await databaseTestQuery(
    `INSERT INTO ascn_call_records
       (tenant_id, id, direction, phone, agent_id, agent_name, provider, model,
        status, variables, error, outcome, first_audio_ms, tool_calls, transfers,
        tool_usage, recorded_seconds, created_at, updated_at, ended_at)
     VALUES
       ('default', $1, 'inbound', '+79990001122', '', '', '', '', 'live',
        '{}'::jsonb, '', NULL, 0, 0, 0, '{}'::jsonb, 0,
        now() - interval '4 hours', now() - interval '4 hours', NULL)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       status = 'live', updated_at = now() - interval '4 hours', ended_at = NULL`,
    [callId],
  );
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
    }
    const result = await databaseTestQuery(
      "SELECT status, ended_at FROM ascn_call_records WHERE tenant_id = 'default' AND id = $1",
      [callId],
    );
    assert.equal(result.rows[0]?.status, "live", "readiness probe must not reconcile application state");
    assert.equal(result.rows[0]?.ended_at, null);
  } finally {
    await databaseTestQuery(
      "DELETE FROM ascn_call_records WHERE tenant_id = 'default' AND id = $1",
      [callId],
    );
  }
});

test("without a trusted proxy, login attempts do not share one global IP bucket", async () => {
  for (let attempt = 0; attempt < 22; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `no-proxy-probe-${attempt}@example.test`, password: "not-the-password" }),
    });
    assert.equal(response.status, 401, `attempt ${attempt + 1} must be limited only by its email identity`);
  }
});

test("environment administrator can sign in through the browser form", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin", password: "test-admin-password" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /ascn_session=[0-9a-f]{64}/);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: "admin", kind: "session" });
});

test("cancels the active response when the caller interrupts", async () => {
  const gateway = await readFile(new URL("../voice-gateway/server.mjs", import.meta.url), "utf8");
  assert.match(gateway, /input_audio_buffer\.speech_started/);
  assert.match(gateway, /type: "response\.cancel"/);
});

test("routes a phone number to an agent and keeps all provider secrets server-side", async () => {
  const createResponse = await fetch(`${baseUrl}/api/voice/agents`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ name: "Поддержка", provider: "yandex", model: "speech-realtime-260528", instructions: "Ты оператор {{service_name}}", variables: [{ id: "service", key: "service_name", value: "ASCN" }], tools: [{ id: "memory", type: "ascn", name: "contact_context" }, { id: "search", type: "web_search" }, { id: "private-mcp", type: "mcp", label: "CRM", url: "https://mcp.example.test", authorization: "Bearer dashboard-must-not-leak", requireApproval: "never" }, { id: "private-function", type: "function", name: "lookup_order", description: "Ищет заказ", parameters: "{}", webhookUrl: "https://hooks.example.test/order", authorization: "function-secret-must-not-leak" }], synthesisEnabled: true, voice: "filipp", speed: 1, recognitionLanguage: "ru-RU", vadEnabled: true, vadThreshold: 0.5, silenceDurationMs: 800, speaksFirst: true, firstMessage: "Здравствуйте", active: true }) });
  assert.equal(createResponse.status, 201);
  const agent = (await createResponse.json()).agent;
  assert.doesNotMatch(JSON.stringify(agent), /dashboard-must-not-leak|function-secret-must-not-leak/, "секреты инструментов не возвращаются в черновике");
  assert.equal(agent.tools.find((tool) => tool.id === "private-mcp").authorizationConfigured, true);
  const publishResponse = await fetch(`${baseUrl}/api/voice/agents/publish`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ id: agent.id }) });
  assert.equal(publishResponse.status, 200);
  const publishedAgent = (await publishResponse.json()).agent;
  assert.doesNotMatch(JSON.stringify(publishedAgent), /dashboard-must-not-leak|function-secret-must-not-leak/, "секреты инструментов не возвращаются и из опубликованного снимка");
  assert.equal(publishedAgent.published.tools.find((tool) => tool.id === "private-function").authorizationConfigured, true);

  const settingsResponse = await fetch(`${baseUrl}/api/voice/settings`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ yandexFolderId: "folder-test", yandexApiKey: "secret-yandex", openaiApiKey: "secret-openai", openaiProjectId: "proj_test", gatewayPublicUrl: "wss://voice.example.test/voice-ws/session", phoneConnections: [{ id: "main-number", name: "Основной номер", providerPreset: "custom", enabled: true, number: "+79990000000", agentId: agent.id, registrar: "sip.example.test", proxy: "", username: "sip-user", password: "secret-sip", transport: "udp", operatorExtension: "+79991111111" }] }) });
  assert.equal(settingsResponse.status, 200);
  const safe = await (await fetch(`${baseUrl}/api/voice/settings`, { headers: { authorization } })).json();
  assert.equal(safe.yandexApiKeyConfigured, true);
  assert.equal(safe.openaiApiKeyConfigured, true);
  assert.equal(safe.phoneConnections[0].passwordConfigured, true);
  assert.equal("yandexApiKey" in safe, false);
  assert.equal("openaiApiKey" in safe, false);
  assert.equal("password" in safe.phoneConnections[0], false);

  const runtimeResponse = await fetch(`${baseUrl}/api/voice/runtime?tenantId=default&connectionId=main-number&direction=inbound&did=79990000000&phone=%2B79991234567`, { headers: { authorization: gatewayAuthorization } });
  assert.equal(runtimeResponse.status, 200);
  const runtime = await runtimeResponse.json();
  assert.match(runtime.agent.instructions, /ASCN/);
  assert.equal(runtime.ai.provider, "yandex");
  assert.equal(runtime.telephony.connectionId, "main-number");
  assert.equal(runtime.contact.phone, "+79991234567");

  const transcript = await fetch(`${baseUrl}/api/voice/runtime`, { method: "POST", headers: { authorization: gatewayAuthorization, "content-type": "application/json" }, body: JSON.stringify({ action: "transcript", tenantId: "default", phone: "+79991234567", direction: "inbound", text: "Нужна помощь" }) });
  assert.equal(transcript.status, 200);
  assert.equal((await transcript.json()).message.callId, null, "browser transcript без callId остаётся в истории контакта");
  const contacts = (await (await fetch(`${baseUrl}/api/calls`, { headers: { authorization } })).json()).contacts;
  assert.equal(contacts[0].lastMessage, "Нужна помощь");
  const messages = (await (await fetch(`${baseUrl}/api/calls/${encodeURIComponent(contacts[0].id)}/messages`, { headers: { authorization } })).json()).messages;
  assert.equal(messages[0].text, "Нужна помощь");

  const startCall = async () => {
    const response = await fetch(`${baseUrl}/api/voice/runtime`, {
      method: "POST",
      headers: { authorization: gatewayAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "call_started", tenantId: "default", direction: "inbound", phone: "+79991234567", connectionId: "main-number", did: "79990000000" }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).call;
  };
  const firstCall = await startCall();
  const secondCall = await startCall();
  for (const [callId, text] of [[firstCall.id, "Только первый звонок"], [secondCall.id, "Только второй звонок"]]) {
    const response = await fetch(`${baseUrl}/api/voice/runtime`, {
      method: "POST",
      headers: { authorization: gatewayAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "transcript", tenantId: "default", callId, phone: "+79991234567", direction: "inbound", text }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message.callId, callId);
  }
  const firstCallDetails = await fetch(`${baseUrl}/api/voice/calls/${firstCall.id}`, { headers: { authorization } });
  assert.equal(firstCallDetails.status, 200);
  assert.deepEqual((await firstCallDetails.json()).messages.map((message) => message.text), ["Только первый звонок"], "карточка звонка не смешивает соседние разговоры одного контакта");

  const terminalStatus = async (status, error) => {
    const response = await fetch(`${baseUrl}/api/voice/runtime`, {
      method: "POST",
      headers: { authorization: gatewayAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "call_status", tenantId: "default", callId: firstCall.id, status, error }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).call;
  };
  const failed = await terminalStatus("failed", "original terminal reason");
  assert.equal(failed.status, "failed");
  const duplicate = await terminalStatus("ended", "late close must not overwrite");
  assert.equal(duplicate.status, "failed", "terminal state is immutable across durable outbox retries");
  assert.equal(duplicate.error, "original terminal reason");

  const tokenResponse = await fetch(`${baseUrl}/api/voice/test-token`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) });
  assert.equal(tokenResponse.status, 200);
});

test("includes current Yandex and OpenAI speech-to-speech Realtime models", async () => {
  const source = await readFile(new URL("../lib/voice-agents.ts", import.meta.url), "utf8");
  for (const model of ["speech-realtime-260528", "speech-realtime-deepseek-v4-flash", "gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime-2", "gpt-realtime-1.5"]) assert.match(source, new RegExp(model.replaceAll(".", "\\.")));
  assert.doesNotMatch(source, /gpt-4o-realtime-preview/);
});

test("reads a call outcome out of a noisy model answer", async () => {
  const { parseOutcome } = await import("../lib/call-outcome.ts");
  const outcome = parseOutcome('```json\n{"resolved": true, "summary": "Приём перенесён на пятницу 17:30", "confirmation": "48213", "operator": "Дарья", "nextStep": ""}\n```');
  assert.deepEqual(outcome, { resolved: true, summary: "Приём перенесён на пятницу 17:30", confirmation: "48213", operator: "Дарья", nextStep: "" });
  assert.equal(parseOutcome("Извините, не могу"), null);
  assert.equal(parseOutcome('{"resolved": "yes", "summary": 5}').resolved, false);
});

test("guards the outbound call API", async () => {
  const anonymous = await fetch(`${baseUrl}/api/voice/calls`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 401);
  const gatewayKeyOnCallApi = await fetch(`${baseUrl}/api/voice/calls`, { method: "POST", headers: { authorization: gatewayAuthorization, "content-type": "application/json" }, body: "{}" });
  assert.equal(gatewayKeyOnCallApi.status, 401, "ключ шлюза не открывает внешний API звонков");
  const externalKeyOnRuntime = await fetch(`${baseUrl}/api/voice/runtime?tenantId=default&direction=browser`, { headers: { authorization: externalCallAuthorization } });
  assert.equal(externalKeyOnRuntime.status, 401, "внешний ключ звонков не открывает внутренний runtime");
  const badNumber = await fetch(`${baseUrl}/api/voice/calls`, {
    method: "POST",
    headers: { authorization: externalCallAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ toNumber: "12" }),
  });
  assert.equal(badNumber.status, 400);
  assert.match((await badNumber.json()).error, /номер/i);
});

test("imports a CSV base and schedules outbound campaign calls without duplicates", async () => {
  const anonymous = await fetch(`${baseUrl}/api/voice/campaigns`);
  assert.equal(anonymous.status, 401);
  const agents = (await (await fetch(`${baseUrl}/api/voice/agents`, { headers: { authorization } })).json()).agents;
  const settings = await (await fetch(`${baseUrl}/api/voice/settings`, { headers: { authorization } })).json();
  const connection = settings.phoneConnections.find((item) => item.enabled && item.passwordConfigured);
  const activeAgent = agents.find((item) => item.id === connection?.agentId && item.active);
  assert.ok(activeAgent && connection, "campaign test needs the configured outbound route");

  const upload = new FormData();
  upload.set("name", "Подтверждение записей");
  upload.set("agentId", activeAgent.id);
  upload.set("connectionId", connection.id);
  upload.set("purposeTemplate", "Подтвердить запись");
  upload.set("intervalSeconds", "60");
  upload.set("file", new File([
    "phone;name;purpose;order_id\n+79991110001;Иван;;A-101\n+79991110002;Анна;Уточнить время;A-102\n+79991110001;Дубль;;A-103\n+bad-number;Ошибка;;A-104\n",
  ], "base.csv", { type: "text/csv" }));
  const createdResponse = await fetch(`${baseUrl}/api/voice/campaigns`, { method: "POST", headers: { authorization }, body: upload });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.deepEqual(created.import, { imported: 2, invalid: 1, duplicates: 1 });
  assert.equal(created.campaign.status, "draft");
  assert.equal(created.campaign.counts.total, 2);

  const startedResponse = await fetch(`${baseUrl}/api/voice/campaigns/${created.campaign.id}`, {
    method: "PATCH", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ action: "start" }),
  });
  assert.equal(startedResponse.status, 200);
  const scheduled = await databaseTestQuery(
    `SELECT campaign.status, campaign.next_run_at <= now() AS due,
            array_agg(recipient.status ORDER BY recipient.position) AS recipient_statuses
     FROM ascn_call_campaigns campaign
     JOIN ascn_call_campaign_recipients recipient
       ON recipient.tenant_id = campaign.tenant_id AND recipient.campaign_id = campaign.id
     WHERE campaign.tenant_id = 'default' AND campaign.id = $1
     GROUP BY campaign.tenant_id, campaign.id`, [created.campaign.id],
  );
  assert.deepEqual(scheduled.rows[0], { status: "running", due: true, recipient_statuses: ["pending", "pending"] });

  const received = [];
  const fakeGateway = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const address = fakeGateway.address();
  const previousGatewayUrl = process.env.VOICE_GATEWAY_INTERNAL_URL;
  const previousGatewayKey = process.env.APP_GATEWAY_KEY;
  process.env.VOICE_GATEWAY_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  process.env.APP_GATEWAY_KEY = "test-app-to-gateway-key-20c37b1a";
  try {
    const { runCampaignSchedulerSweep } = await import("../lib/campaigns.ts");
    const { withTenant } = await import("../lib/tenant-context.ts");
    const firstDispatch = await withTenant("default", () => runCampaignSchedulerSweep());
    let detail = await (await fetch(`${baseUrl}/api/voice/campaigns/${created.campaign.id}`, { headers: { authorization } })).json();
    assert.equal(firstDispatch, 1, detail.campaign.recipients[0]?.error || "scheduler did not claim a due recipient");
    assert.equal(detail.campaign.recipients[0].status, "dialing");
    assert.equal(detail.campaign.recipients[0].variables.caller_name, "Иван");
    assert.equal(detail.campaign.recipients[0].variables.caller_purpose, "Подтвердить запись");
    assert.equal(detail.campaign.recipients[0].variables.order_id, "A-101");
    assert.equal(received.length, 1);
    assert.equal(received[0].callId, detail.campaign.recipients[0].callId, "campaign reserves a stable call id before gateway dispatch");

    await databaseTestQuery(
      `UPDATE ascn_call_records SET status = 'ended', ended_at = now(), updated_at = now()
       WHERE tenant_id = 'default' AND id = $1`, [detail.campaign.recipients[0].callId],
    );
    await databaseTestQuery(
      `UPDATE ascn_call_campaigns SET next_run_at = now()
       WHERE tenant_id = 'default' AND id = $1`, [created.campaign.id],
    );
    assert.equal(await withTenant("default", () => runCampaignSchedulerSweep()), 1);
    detail = await (await fetch(`${baseUrl}/api/voice/campaigns/${created.campaign.id}`, { headers: { authorization } })).json();
    assert.equal(detail.campaign.recipients[0].status, "completed");
    assert.equal(detail.campaign.recipients[1].status, "dialing");
    assert.equal(received.length, 2, "every unique CSV phone is dispatched exactly once");
    assert.equal(received[1].callId, detail.campaign.recipients[1].callId);

    await databaseTestQuery(
      `UPDATE ascn_call_campaign_recipients
       SET status = 'dispatching', updated_at = now() - interval '10 minutes'
       WHERE tenant_id = 'default' AND campaign_id = $1 AND id = $2`,
      [created.campaign.id, detail.campaign.recipients[1].id],
    );
    assert.equal(await withTenant("default", () => runCampaignSchedulerSweep()), 0, "an accepted call survives a scheduler restart without redialing");
    detail = await (await fetch(`${baseUrl}/api/voice/campaigns/${created.campaign.id}`, { headers: { authorization } })).json();
    assert.equal(detail.campaign.recipients[1].status, "dialing");
    assert.equal(received.length, 2);
  } finally {
    if (previousGatewayUrl === undefined) delete process.env.VOICE_GATEWAY_INTERNAL_URL; else process.env.VOICE_GATEWAY_INTERNAL_URL = previousGatewayUrl;
    if (previousGatewayKey === undefined) delete process.env.APP_GATEWAY_KEY; else process.env.APP_GATEWAY_KEY = previousGatewayKey;
    fakeGateway.closeAllConnections();
    await new Promise((resolve) => fakeGateway.close(resolve));
    const { closeDatabasePool } = await import("../lib/db.ts");
    await closeDatabasePool();
  }
});

test("treats DeepSeek as its own provider but keeps the Yandex transport", async () => {
  await fetch(`${baseUrl}/api/voice/settings`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ yandexFolderId: "folder-deepseek", yandexApiKey: "secret-yandex", phoneConnections: [] }),
  });
  const created = await fetch(`${baseUrl}/api/voice/agents`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "DeepSeek агент", provider: "yandex", model: "speech-realtime-deepseek-v4-flash", instructions: "Отвечай коротко", active: false }),
  });
  assert.equal(created.status, 201);
  const agent = (await created.json()).agent;
  assert.equal(agent.provider, "deepseek");
  assert.equal(agent.model, "speech-realtime-deepseek-v4-flash");

  const runtime = await fetch(`${baseUrl}/api/voice/runtime?tenantId=default&direction=browser&phone=%2B79995550000&agentId=${agent.id}`, { headers: { authorization: gatewayAuthorization } });
  assert.equal(runtime.status, 409);
  assert.match((await runtime.json()).error, /выключен/i);

  await fetch(`${baseUrl}/api/voice/agents`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ ...agent, active: true }) });
  const live = await fetch(`${baseUrl}/api/voice/runtime?tenantId=default&direction=browser&phone=%2B79995550000&agentId=${agent.id}`, { headers: { authorization: gatewayAuthorization } });
  assert.equal(live.status, 200);
  const session = await live.json();
  assert.equal(session.agent.provider, "deepseek");
  assert.equal(session.ai.provider, "yandex");
  assert.equal(session.ai.folderId, "folder-deepseek");
});

test("resamples realtime audio between provider and telephony rates", async () => {
  const { resamplePcm16 } = await import("../voice-gateway/audio.mjs");
  const pcm = Buffer.alloc(4800);
  for (let index = 0; index < 2400; index += 1) pcm.writeInt16LE(Math.round(10000 * Math.sin(index * 2 * Math.PI / 300)), index * 2);

  const down = resamplePcm16(pcm, 24000, 8000);
  assert.equal(down.length, pcm.length / 3);
  let peak = 0;
  for (let index = 0; index < down.length / 2; index += 1) peak = Math.max(peak, Math.abs(down.readInt16LE(index * 2)));
  assert.ok(peak > 9000 && peak < 11000, `амплитуда должна сохраниться, получили ${peak}`);

  assert.equal(resamplePcm16(down, 8000, 24000).length, pcm.length);
  assert.equal(resamplePcm16(pcm, 8000, 8000), pcm);
  assert.equal(resamplePcm16(Buffer.alloc(0), 24000, 8000).length, 0);

  // Понижение частоты обязано отсекать всё выше 4 кГц, иначе в трубке хрип:
  // тон 6 кГц завернулся бы в 2 кГц и звучал наравне с речью.
  const mixed = Buffer.alloc(24000 * 2);
  for (let index = 0; index < 24000; index += 1) {
    const value = 9000 * Math.sin(2 * Math.PI * 800 * index / 24000) + 9000 * Math.sin(2 * Math.PI * 6000 * index / 24000);
    mixed.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  const telephony = resamplePcm16(mixed, 24000, 8000);
  const level = (buffer, frequency) => {
    const count = Math.floor(buffer.length / 2);
    const step = 2 * Math.PI * frequency / 8000;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < count; index += 1) {
      real += buffer.readInt16LE(index * 2) * Math.cos(step * index);
      imaginary += buffer.readInt16LE(index * 2) * Math.sin(step * index);
    }
    return Math.sqrt(real * real + imaginary * imaginary) / count;
  };
  const useful = level(telephony, 800);
  const ghost = level(telephony, 2000);
  assert.ok(useful / Math.max(ghost, 0.01) > 30, `зеркальная частота должна быть подавлена минимум в 30 раз, получили ${(useful / ghost).toFixed(1)}`);
});

test("keeps xAI as its own transport with its own key", async () => {
  const { providerTransport, realtimeModelCatalog } = await import("../lib/voice-agents.ts");
  assert.equal(providerTransport("xai"), "xai");
  assert.equal(providerTransport("deepseek"), "yandex");
  assert.equal(providerTransport("openai"), "openai");
  const grok = realtimeModelCatalog.filter((model) => model.provider === "xai");
  assert.equal(grok.length, 1);
  assert.equal(grok[0].id, "grok-voice-think-fast-2.0");

  const created = await fetch(`${baseUrl}/api/voice/agents`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "Grok агент", model: "grok-voice-think-fast-2.0", instructions: "Отвечай коротко", voice: "xai_ara", active: true }),
  });
  assert.equal(created.status, 201);
  const agent = (await created.json()).agent;
  assert.equal(agent.provider, "xai");

  const runtime = await fetch(`${baseUrl}/api/voice/runtime?tenantId=default&direction=browser&phone=%2B79995550001&agentId=${agent.id}`, { headers: { authorization: gatewayAuthorization } });
  assert.equal(runtime.status, 409);
  assert.match((await runtime.json()).error, /xAI/);
});

test("считает показатели звонков: медианы, стоимость и доли", async () => {
  const { aggregateCalls } = await import("../lib/insights.ts");
  const call = (id, startMinute, seconds, extra = {}) => ({
    id, direction: "inbound", phone: "+79001112233", agentId: "a", agentName: "Кроссовки",
    provider: "xai", model: "grok-voice-think-fast-2.0", status: "ended", variables: {}, error: "",
    outcome: null, firstAudioMs: 0, toolCalls: 0, transfers: 0,
    createdAt: `2026-08-19T10:${String(startMinute).padStart(2, "0")}:00.000Z`,
    updatedAt: "", endedAt: new Date(Date.parse(`2026-08-19T10:${String(startMinute).padStart(2, "0")}:00.000Z`) + seconds * 1000).toISOString(),
    ...extra,
  });
  const calls = [
    call("aaa", 0, 60, { firstAudioMs: 900, toolCalls: 2 }),
    call("bbb", 5, 120, { firstAudioMs: 1500, toolCalls: 1, transfers: 1 }),
    call("ccc", 10, 300, { firstAudioMs: 2100 }),
    call("ddd", 15, 0, { status: "failed", error: "SIP 503", endedAt: "" }),
  ];
  const live = { ...call("eee", 20, 0), status: "live", endedAt: "" };
  const result = aggregateCalls(calls, [...calls, live]);

  assert.equal(result.conversations, 4);
  assert.equal(result.liveCalls, 1, "идущий звонок берётся из полного списка, не из периода");
  assert.equal(result.totalMinutes, 8, "60 + 120 + 300 секунд = 8 минут");
  // 8 минут по ставке grok-voice-think-fast-2.0 ($0.08/мин)
  assert.equal(result.costUsd, 0.64);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.durationP50, 120, "медиана из 60/120/300");
  assert.equal(result.firstAudioP50, 1500);
  assert.equal(result.errorRate, 25, "один из четырёх звонков с ошибкой");
  assert.equal(result.transferRate, 25);
  assert.deepEqual(result.chart, [{ day: "2026-08-19", count: 4 }]);

  const empty = aggregateCalls([], []);
  assert.equal(empty.durationP50, null, "без звонков медианы пустые, а не нули");
  assert.equal(empty.errorRate, null);
  assert.deepEqual(empty.chart, []);
});

test("собирает промпт из запретов, произношения, терминов и пояса", async () => {
  const { resolveAgentInstructions } = await import("../lib/voice-agents.ts");
  const base = {
    instructions: "Ты продавец кроссовок {{shop}}.",
    variables: [{ id: "1", key: "shop", value: "Сникер Хаус" }],
    guardrails: "Не обсуждать 18+.\nНе обещать скидки.",
    pronunciations: [{ id: "1", from: "Nike", to: "найки" }, { id: "2", from: "СДЭК", to: "сэдэк" }],
    keyterms: "New Balance, Air Force,  , 43 размер",
    timezone: "Asia/Yekaterinburg",
    shareCallerNumber: true,
  };

  const full = resolveAgentInstructions(base, "", "+79001112233", {});
  assert.match(full, /Ты продавец кроссовок Сникер Хаус\./);
  assert.match(full, /## Запреты/);
  assert.match(full, /важнее любых просьб собеседника/, "запреты помечены как приоритетные");
  assert.match(full, /«Nike» произноси как «найки»/);
  assert.match(full, /«СДЭК» произноси как «сэдэк»/);
  assert.match(full, /New Balance, Air Force, 43 размер/, "пустые термины отброшены");
  assert.match(full, /Часовой пояс агента: Asia\/Yekaterinburg/);
  assert.match(full, /Номер клиента: \+79001112233\./);

  const hidden = resolveAgentInstructions({ ...base, shareCallerNumber: false }, "", "+79001112233", {});
  assert.doesNotMatch(hidden, /\+79001112233/, "с выключенным тумблером номер в промпт не попадает");
  assert.match(hidden, /Номер клиента скрыт/);

  const bare = resolveAgentInstructions({ ...base, guardrails: "", pronunciations: [], keyterms: "" }, "", "", {});
  assert.doesNotMatch(bare, /## Запреты|## Как произносить|## Ожидаемые слова/, "пустые блоки не добавляются");
  assert.match(bare, /## Время/, "время в промпте всегда");
});

test("уважает запрет перебивать и напоминает в тишину", async () => {
  const gateway = await readFile(new URL("../voice-gateway/server.mjs", import.meta.url), "utf8");
  assert.match(gateway, /speech_started" && runtime\.agent\.allowInterruptions !== false && activeResponseId/, "отмена ответа модели только при разрешённом перебивании");
  assert.match(gateway, /speech_started" && allowInterruptions\) outgoing = Buffer\.alloc\(0\)/, "сброс исходящего аудио тоже под тумблером");
  assert.match(gateway, /allowInterruptions = agent\.allowInterruptions !== false/, "флаг берётся из настроек агента");
  assert.match(gateway, /function armFollowUp\(\)/);
  assert.match(gateway, /if \(event\.type === "response\.done"\) \{\s+activeResponseId = "";\s+armFollowUp\(\);/, "таймер заводится после ответа агента");
  assert.match(gateway, /speech_started"\) clearTimeout\(followUpTimer\)/, "речь собеседника снимает таймер");
  assert.match(gateway, /upstream\.on\("close", \(\) => \{ clearTimeout\(followUpTimer\)/, "таймер снимается при закрытии сессии");
});

test("импортирует legacy JSON в PostgreSQL и дополняет старых агентов", async () => {
  const response = await fetch(`${baseUrl}/api/voice/agents`, { headers: { authorization } });
  assert.equal(response.status, 200);
  const agent = (await response.json()).agents.find((item) => item.id === "legacy-agent");
  assert.ok(agent, "legacy-запись, созданная до старта, импортирована в PostgreSQL");
  assert.equal(agent.guardrails, "");
  assert.deepEqual(agent.pronunciations, []);
  assert.equal(agent.keyterms, "");
  assert.equal(agent.followUpSeconds, 0);
  assert.equal(agent.allowInterruptions, true, "перебивания по умолчанию разрешены");
  assert.equal(agent.shareCallerNumber, true);
  assert.equal(agent.timezone, "Europe/Moscow");
  assert.equal(agent.updatedAt, "2026-08-01T00:00:00.000Z", "импорт не переписывает дату изменения");

  const normalized = await databaseTestQuery(`
    SELECT
      (SELECT count(*)::integer FROM ascn_voice_stores) AS legacy_rows,
      (SELECT count(*)::integer FROM ascn_voice_settings WHERE tenant_id = 'default') AS settings_rows,
      (SELECT count(*)::integer FROM ascn_voice_agents WHERE tenant_id = 'default' AND id = 'legacy-agent') AS agent_rows
  `);
  assert.deepEqual(normalized.rows[0], { legacy_rows: 0, settings_rows: 1, agent_rows: 1 }, "legacy blob перенесён и удалён после проверки normalized rows");
});

test("редактирование агента обновляет только его PostgreSQL row", async () => {
  const create = async (name) => {
    const response = await fetch(`${baseUrl}/api/voice/agents`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ name, instructions: `Промпт ${name}`, provider: "yandex", model: "speech-realtime-260528" }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).agent;
  };
  const edited = await create("Изменяемая строка");
  const untouched = await create("Контрольная строка");
  const before = await databaseTestQuery(
    "SELECT xmin::text AS version, agent FROM ascn_voice_agents WHERE tenant_id = 'default' AND id = $1",
    [untouched.id],
  );

  const update = await fetch(`${baseUrl}/api/voice/agents`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ ...edited, name: "Изменена только одна строка" }),
  });
  assert.equal(update.status, 200);
  const after = await databaseTestQuery(
    "SELECT xmin::text AS version, agent FROM ascn_voice_agents WHERE tenant_id = 'default' AND id = $1",
    [untouched.id],
  );
  assert.deepEqual(after.rows[0], before.rows[0], "чужой JSONB и MVCC version не переписаны");

  await fetch(`${baseUrl}/api/voice/agents?id=${edited.id}`, { method: "DELETE", headers: { authorization } });
  await fetch(`${baseUrl}/api/voice/agents?id=${untouched.id}`, { method: "DELETE", headers: { authorization } });
});

test("отправляет письмо после звонка своим SMTP-клиентом", async () => {
  const { sendMail } = await import("../lib/mailer.ts");
  const seen = [];
  const smtp = createServer((socket) => {
    let data = false;
    socket.on("error", () => undefined);
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (!line && !data) continue;
        if (data) {
          if (line === ".") { data = false; seen.push("BODY_END"); socket.write("250 accepted\r\n"); }
          else seen.push(`BODY:${line}`);
          continue;
        }
        seen.push(line);
        if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 AUTH LOGIN\r\n");
        else if (/^AUTH LOGIN/i.test(line)) socket.write("334 VXNlcm5hbWU6\r\n");
        else if (/^MAIL FROM/i.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO/i.test(line)) socket.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) { data = true; socket.write("354 send it\r\n"); }
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) socket.write(seen.filter((item) => /^[A-Za-z0-9+/=]+$/.test(item)).length === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 authenticated\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const { port } = smtp.address();
  try {
    await sendMail(
      { host: "127.0.0.1", port, user: "robot@ascn.ai", password: "s3cret", from: "robot@ascn.ai" },
      "boss@ascn.ai",
      "Звонок +79001112233 — задача выполнена",
      "Агент: Артём\nИтог: заказ оформлен\n.точка в начале строки",
    );
  } finally {
    await new Promise((resolve) => smtp.close(resolve));
  }

  assert.ok(seen.some((line) => line.startsWith("EHLO")), "клиент здоровается");
  assert.ok(seen.includes("AUTH LOGIN"), "авторизация запрошена");
  assert.ok(seen.includes(Buffer.from("robot@ascn.ai", "utf8").toString("base64")), "логин отправлен в base64");
  assert.ok(seen.includes(Buffer.from("s3cret", "utf8").toString("base64")), "пароль отправлен в base64");
  assert.ok(seen.includes("MAIL FROM:<robot@ascn.ai>"));
  assert.ok(seen.includes("RCPT TO:<boss@ascn.ai>"));
  assert.ok(seen.includes("BODY_END"), "тело письма завершено точкой");
  const body = seen.filter((line) => line.startsWith("BODY:")).map((line) => line.slice(5));
  const subject = body.find((line) => line.startsWith("Subject:"));
  assert.equal(subject, `Subject: =?UTF-8?B?${Buffer.from("Звонок +79001112233 — задача выполнена", "utf8").toString("base64")}?=`, "кириллица в теме закодирована");
  assert.ok(body.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(body.includes("Агент: Артём"), "кириллица в теле проходит как есть");
  assert.ok(body.includes("..точка в начале строки"), "точка в начале строки экранирована, иначе она обрывает письмо");
});

test("ищет ответ в базе знаний агента", async () => {
  const { searchKnowledge } = await import("../lib/knowledge.ts");
  const files = [
    { id: "1", name: "Доставка.md", text: "Доставка СДЭК по России 350 рублей, срок три дня.\n\nСамовывоз из магазина на Ленина бесплатно." },
    { id: "2", name: "Возврат.md", text: "Возврат кроссовок в течение 14 дней, если не носили на улице.\n\nОбмен размера бесплатный один раз." },
  ];

  const delivery = searchKnowledge(files, "сколько стоит доставка сдэк");
  assert.ok(delivery.length > 0, "находит абзац по словам клиента");
  assert.match(delivery[0].text, /350 рублей/);
  assert.equal(delivery[0].file, "Доставка.md", "возвращает, в каком файле нашлось");

  const exchange = searchKnowledge(files, "можно обменять размер");
  assert.match(exchange[0].text, /Обмен размера/);

  const plural = searchKnowledge(files, "условия доставки");
  assert.match(plural[0].text, /Доставка СДЭК/, "окончание слова не мешает: «доставки» находит «доставка»");

  const byTitle = searchKnowledge(files, "правила возврата");
  assert.equal(byTitle[0].file, "Возврат.md", "совпадение с именем файла выводит нужную тему вперёд");

  assert.deepEqual(searchKnowledge(files, "гарантия на телевизор"), [], "по несуществующей теме ничего не выдумывает");
  assert.deepEqual(searchKnowledge(files, "а"), [], "слишком короткий запрос не ищется");
  assert.deepEqual(searchKnowledge(files, "скажите пожалуйста можно ли"), [], "из служебных слов запрос не собирается");
  assert.equal(searchKnowledge(files, "доставка возврат обмен", 2).length, 2, "лимит результатов соблюдается");

  const latin = [{ id: "3", name: "Каталог.md", text: "New Balance 550, размеры 38-45, 15 900 руб." }];
  assert.deepEqual(searchKnowledge(latin, "есть нью бэланс пятьсот пятьдесят"), [], "без подсказки латиница на слух не находится");
  const viaAlias = searchKnowledge(latin, "есть нью бэланс пятьсот пятьдесят", 5, [{ from: "New Balance", to: "нью бэланс" }]);
  assert.match(viaAlias[0]?.text || "", /New Balance 550/, "замена произношения работает и в обратную сторону, для поиска");
});

test("звонки идут по опубликованному снимку, а не по черновику", async () => {
  const json = { "content-type": "application/json" };
  const draft = {
    name: "Публикуемый агент", description: "", provider: "yandex", model: "speech-realtime-260528",
    instructions: "ПЕРВАЯ ВЕРСИЯ промпта.", variables: [], tools: [], synthesisEnabled: true, voice: "filipp",
    role: "", speed: 1, recognitionLanguage: "auto", vadEnabled: true, vadThreshold: 0.5, silenceDurationMs: 400,
    speaksFirst: true, firstMessage: "Здравствуйте!", active: true, knowledge: [],
  };
  const created = (await (await fetch(`${baseUrl}/api/voice/agents`, { method: "POST", headers: { authorization, ...json }, body: JSON.stringify(draft) })).json()).agent;
  assert.equal(created.live, false, "новый агент ещё не опубликован");
  assert.equal(created.unpublished, false, "без публикации нечего сравнивать");

  const published = (await (await fetch(`${baseUrl}/api/voice/agents/publish`, { method: "POST", headers: { authorization, ...json }, body: JSON.stringify({ id: created.id }) })).json()).agent;
  assert.equal(published.live, true);
  assert.ok(published.publishedAt, "дата публикации записана");
  assert.equal(published.unpublished, false);

  await fetch(`${baseUrl}/api/voice/agents`, { method: "PUT", headers: { authorization, ...json }, body: JSON.stringify({ ...published, instructions: "ВТОРАЯ ВЕРСИЯ промпта." }) });
  const listed = (await (await fetch(`${baseUrl}/api/voice/agents`, { headers: { authorization } })).json()).agents.find((item) => item.id === created.id);
  assert.equal(listed.instructions, "ВТОРАЯ ВЕРСИЯ промпта.", "черновик обновился");
  assert.equal(listed.unpublished, true, "панель показывает, что черновик расходится с опубликованным");

  const session = await (await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", tenantId: "default", direction: "browser", phone: "+79991234567", agentId: created.id }),
  })).json();
  assert.match(session.agent.instructions, /ПЕРВАЯ ВЕРСИЯ/, "звонок идёт по опубликованному промпту");
  assert.doesNotMatch(session.agent.instructions, /ВТОРАЯ ВЕРСИЯ/, "черновик в звонок не попадает");

  const republished = (await (await fetch(`${baseUrl}/api/voice/agents/publish`, { method: "POST", headers: { authorization, ...json }, body: JSON.stringify({ id: created.id }) })).json()).agent;
  assert.equal(republished.unpublished, false, "после повторной публикации расхождения нет");
  const after = await (await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", tenantId: "default", direction: "browser", phone: "+79991234567", agentId: created.id }),
  })).json();
  assert.match(after.agent.instructions, /ВТОРАЯ ВЕРСИЯ/, "новая версия ушла в звонки");

  const removed = (await (await fetch(`${baseUrl}/api/voice/agents/publish`, { method: "POST", headers: { authorization, ...json }, body: JSON.stringify({ id: created.id, live: false }) })).json()).agent;
  assert.equal(removed.live, false, "публикацию можно снять");
  const fallback = await (await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", tenantId: "default", direction: "browser", phone: "+79991234567", agentId: created.id }),
  })).json();
  assert.match(fallback.agent.instructions, /ВТОРАЯ ВЕРСИЯ/, "без снимка звонки идут по черновику — старые агенты не ломаются");

  await fetch(`${baseUrl}/api/voice/agents?id=${created.id}`, { method: "DELETE", headers: { authorization } });
});

test("прямой SIP пускает только зарезервированный точный public IP", async () => {
  const source = await readFile(new URL("../lib/voice-agents.ts", import.meta.url), "utf8");
  assert.match(source, /type=identify/, "прямой режим опознаёт звонок по адресу отправителя");
  assert.match(source, /item\.mode === "direct" \? item\.allowedAddresses\.length > 0/, "без списка адресов транк не считается готовым");

  const rejected = await fetch(`${baseUrl}/api/voice/settings`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      phoneConnections: [
        { id: "direct-1", name: "СИПНЕТ прямой", number: "74951234567", mode: "direct", transport: "udp", registrar: "sipnet.ru", allowedAddresses: ["212.53.40.0/24", "sipnet.ru", "не адрес", "999.999.999.999", "10.0.0.1/64", "1.2.3.4/24/8"] },
      ],
    }),
  });
  assert.equal(rejected.status, 400, "широкие CIDR и DNS не могут стать tenant identity");

  const response = await fetch(`${baseUrl}/api/voice/settings`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      phoneConnections: [
        { id: "direct-1", name: "СИПНЕТ прямой", number: "74951234567", mode: "direct", transport: "udp", registrar: "sipnet.ru", allowedAddresses: ["212.53.40.1/32"] },
        { id: "reg-1", name: "СИПНЕТ регистрация", number: "74951234568", mode: "register", registrar: "sipnet.ru", username: "0000000000", password: "secret", transport: "udp" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const config = await readFile(join(dataDirectory, "asterisk", "pjsip-provider.conf"), "utf8");

  assert.match(config, /match=212\.53\.40\.1/, "в identify попал канонический зарезервированный IP");
  assert.doesNotMatch(config, /match=.*\//, "CIDR не попадает в identify");
  const directBlock = config.slice(config.indexOf("СИПНЕТ прямой"), config.indexOf("СИПНЕТ регистрация"));
  assert.doesNotMatch(directBlock, /type=auth|type=registration/, "прямому SIP не нужны пароль и регистрация");
  assert.match(config, /type=registration/, "обычный транк по-прежнему регистрируется");
  assert.match(directBlock, /set_var=ASCN_TENANT_ID=default/, "PJSIP endpoint закрепляет доверенный tenantId на канале");
  assert.match(directBlock, /set_var=ASCN_CONNECTION_ID=direct-1/, "PJSIP endpoint закрепляет connectionId на канале");
});

test("cross-tenant SIP collision откатывает настройки до COMMIT", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: collisionTenantEmail, password: collisionTenantPassword }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie);

  const collision = await fetch(`${baseUrl}/api/voice/settings`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      phoneConnections: [{
        id: "other-direct",
        name: "Конфликтующий direct SIP",
        number: "74951234569",
        mode: "direct",
        transport: "udp",
        allowedAddresses: ["212.53.40.1"],
      }],
    }),
  });
  assert.equal(collision.status, 400);
  assert.match((await collision.json()).error, /пересекается с другим подключением/i);

  const settings = await (await fetch(`${baseUrl}/api/voice/settings`, { headers: { cookie } })).json();
  assert.deepEqual(settings.phoneConnections, [], "невалидная строка не пережила rollback");
});

test("разбирает ответ помощника по сборке агента", async () => {
  const { parseBuilderAnswer } = await import("../lib/agent-draft.ts");

  const question = parseBuilderAnswer('{"reply": "Чем занимается магазин?", "ready": false, "draft": null}');
  assert.equal(question.reply, "Чем занимается магазин?");
  assert.equal(question.ready, false);
  assert.equal(question.draft, null);

  const fenced = parseBuilderAnswer('Вот результат:\n```json\n{"reply": "Готово", "ready": true, "draft": {"name": "Артём", "description": "Продажи", "instructions": "Ты продавец {{store}}.", "firstMessage": "Здравствуйте!", "keyterms": "Nike, СДЭК", "guardrails": "Не обещать скидки"}}\n```');
  assert.equal(fenced.ready, true, "JSON в блоке кода тоже разбирается");
  assert.equal(fenced.draft.name, "Артём");
  assert.match(fenced.draft.instructions, /\{\{store\}\}/, "подстановки сохраняются");
  assert.equal(fenced.draft.guardrails, "Не обещать скидки");

  const noDraft = parseBuilderAnswer('{"reply": "Почти готово", "ready": true, "draft": {"name": "Пустой"}}');
  assert.equal(noDraft.ready, false, "без промпта агент не считается собранным");
  assert.equal(noDraft.draft, null);

  const plain = parseBuilderAnswer("А какой у вас график работы?");
  assert.equal(plain.ready, false);
  assert.equal(plain.reply, "А какой у вас график работы?", "обычный текст считаем вопросом, а не ошибкой");

  const noisy = parseBuilderAnswer('чуть-чуть текста {"reply": "Собрал", "ready": true, "draft": {"instructions": "Ты оператор."}} и ещё текст');
  assert.equal(noisy.ready, true, "объект находится внутри болтовни модели");
  assert.equal(noisy.draft.name, "Голосовой агент", "имя по умолчанию, если модель его не дала");
});

test("частые вызовы идут на дешёвой модели, разовые — на сильной", async () => {
  const source = await readFile(new URL("../lib/text-model.ts", import.meta.url), "utf8");
  const cheapFirst = source.match(/xai: \{ cheap: \["([^"]+)"/);
  const qualityFirst = source.match(/quality: \["([^"]+)"/);
  assert.equal(cheapFirst?.[1], "grok-4.20-0309-non-reasoning", "в быстром уровне первой идёт модель без размышлений: они тарифицируются как выход и добавляют секунды");
  assert.equal(qualityFirst?.[1], "grok-4.5", "в сильном уровне первой идёт флагман");
  assert.match(source, /cheap: \["grok-4\.20-0309-non-reasoning", "grok-4\.3", "grok-4\.5"\]/, "при перегрузке берётся следующая, а не падаем");

  const builder = await readFile(new URL("../app/api/voice/agent-builder/route.ts", import.meta.url), "utf8");
  assert.match(builder, /askTextModel\([\s\S]*?"cheap"\)/, "чат-помощник просит дешёвый уровень");

  const improve = await readFile(new URL("../app/api/voice/improve-prompt/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(improve, /"cheap"/, "«Улучшить моделью» остаётся на сильной модели");
});

test("пишет разговор в стерео: слева абонент, справа агент", async () => {
  const { startRecording } = await import("../voice-gateway/recorder.mjs");
  const directory = await mkdtemp(join(tmpdir(), "ascn-rec-"));
  try {
    assert.equal(startRecording(directory, "../../etc/passwd"), null, "идентификатор подставляется в путь — чужие пути отбиваются");
    assert.equal(startRecording("", "11111111-2222-4333-8444-555555555555"), null, "без каталога записи не пишем");

    const id = "11111111-2222-4333-8444-555555555555";
    const recorder = startRecording(directory, id);
    const caller = Buffer.alloc(320);
    const agent = Buffer.alloc(320);
    for (let i = 0; i < 160; i += 1) { caller.writeInt16LE(1000, i * 2); agent.writeInt16LE(-2000, i * 2); }
    for (let frame = 0; frame < 50; frame += 1) recorder.frame(caller, agent);
    const seconds = await recorder.close();

    assert.equal(seconds, 1, "50 кадров по 20 мс — это ровно секунда");
    const raw = await readFile(join(directory, `${id}.wav`));
    assert.equal(raw.subarray(0, 4).toString(), "RIFF");
    assert.equal(raw.readUInt16LE(22), 2, "две дорожки");
    assert.equal(raw.readUInt32LE(24), 8000);
    assert.equal(raw.readUInt16LE(34), 16);
    assert.equal(raw.readUInt32LE(40), raw.length - 44, "размер в заголовке дописан после закрытия и сходится с файлом");
    assert.equal(raw.readInt16LE(44), 1000, "слева абонент");
    assert.equal(raw.readInt16LE(46), -2000, "справа агент");

    // Кадр абонента короче кадра агента — молчание добивается нулями, дорожки не съезжают.
    const short = startRecording(directory, "22222222-2222-4333-8444-555555555555");
    short.frame(Buffer.alloc(80), agent);
    await short.close();
    const uneven = await readFile(join(directory, "22222222-2222-4333-8444-555555555555.wav"));
    assert.equal(uneven.readUInt32LE(40), 160 * 4, "длина кадра берётся по более длинной дорожке");
    assert.equal(uneven.readInt16LE(44 + 100 * 4), 0, "хвост абонента заполнен тишиной");
    assert.equal(uneven.readInt16LE(44 + 100 * 4 + 2), -2000, "агент на этом же месте звучит");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("каждый пользователь видит только своих агентов, входящий связан с доверенным SIP endpoint", async () => {
  const json = { "content-type": "application/json" };
  const cookieOf = (response) => (response.headers.get("set-cookie") || "").split(";")[0];

  // Два независимых аккаунта
  const registerA = await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email: "a@test.ru", password: "password-a" }) });
  assert.equal(registerA.status, 201);
  const cookieA = cookieOf(registerA);
  assert.match(cookieA, /ascn_session=[0-9a-f]{64}/, "регистрация сразу выдаёт сессию");

  const registerB = await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email: "b@test.ru", password: "password-b" }) });
  const cookieB = cookieOf(registerB);

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email: "a@test.ru", password: "password-x" }) });
  assert.equal(duplicate.status, 400, "повторная почта не проходит");

  const wrong = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "a@test.ru", password: "wrong-pass" }) });
  assert.equal(wrong.status, 401);

  // A подключает ключ, агента и номер
  await fetch(`${baseUrl}/api/voice/settings`, { method: "PUT", headers: { ...json, cookie: cookieA }, body: JSON.stringify({ xaiApiKey: "test-key-a", phoneConnections: [{ id: "a-phone", name: "Номер A", number: "74959998877", mode: "register", registrar: "sipnet.ru", username: "111", password: "222", transport: "udp", enabled: true }] }) });
  const created = await fetch(`${baseUrl}/api/voice/agents`, { method: "POST", headers: { ...json, cookie: cookieA }, body: JSON.stringify({ name: "Агент арендатора A", instructions: "МАРКЕР-ТЕНАНТА-A. Ты агент.", provider: "xai", model: "grok-voice-think-fast-2.0", variables: [], tools: [], active: true }) });
  assert.equal(created.status, 201);
  const createdAgent = (await created.json()).agent;
  const tenantToken = await (await fetch(`${baseUrl}/api/voice/test-token`, { method: "POST", headers: { ...json, cookie: cookieA }, body: JSON.stringify({ agentId: createdAgent.id }) })).json();
  const tenantA = String(tenantToken.token || "").split(".")[1];
  assert.match(tenantA, /^[0-9a-f-]{36}$/i);

  // B и админ установки не видят агента A
  const listB = await (await fetch(`${baseUrl}/api/voice/agents`, { headers: { cookie: cookieB } })).json();
  assert.equal(listB.agents.length, 0, "у B пусто — данные не перетекают");
  const listAdmin = await (await fetch(`${baseUrl}/api/voice/agents`, { headers: { authorization } })).json();
  assert.ok(!listAdmin.agents.some((agent) => agent.name === "Агент арендатора A"), "админ установки живёт в своём тенанте");
  const settingsB = await (await fetch(`${baseUrl}/api/voice/settings`, { headers: { cookie: cookieB } })).json();
  assert.equal((settingsB.phoneConnections || []).length, 0, "номера тоже изолированы");

  // Совсем без входа API закрыт
  const anonymous = await fetch(`${baseUrl}/api/voice/agents`);
  assert.equal(anonymous.status, 401);

  // Поддельный DID не может переключить звонок endpoint владельца установки в A.
  const spoofed = await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", direction: "inbound", tenantId: "default", connectionId: "a-phone", phone: "+79991234567", did: "74959998877" }),
  });
  assert.equal(spoofed.status, 403, "чужой connectionId не ищется по DID в других тенантах");

  const aliasDid = await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", direction: "inbound", tenantId: tenantA, connectionId: "a-phone", phone: "+79991234567", did: "74950000000" }),
  });
  assert.equal(aliasDid.status, 200, "endpoint остаётся authority при DID alias оператора");

  const serviceDid = await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", direction: "inbound", tenantId: tenantA, connectionId: "a-phone", phone: "+79991234567", did: "s" }),
  });
  assert.equal(serviceDid.status, 200, "endpoint-bound входящий принимает служебный DID s");

  const missingConnection = await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", direction: "inbound", tenantId: tenantA, phone: "+79991234567", did: "74959998877" }),
  });
  assert.equal(missingConnection.status, 403, "входящий без connectionId не откатывается к поиску владельца по DID");

  // Доверенные tenant/connection из PJSIP endpoint определяют маршрут; DID — метаданные.
  const session = await fetch(`${baseUrl}/api/voice/runtime`, {
    method: "POST",
    headers: { authorization: gatewayAuthorization, ...json },
    body: JSON.stringify({ action: "session", direction: "inbound", tenantId: tenantA, connectionId: "a-phone", phone: "+79991234567", did: "74959998877" }),
  });
  assert.equal(session.status, 200, "сессия по endpoint и DID собирается");
  const built = await session.json();
  assert.match(built.agent.instructions, /МАРКЕР-ТЕНАНТА-A/, "входящий на номер A получает агента A");
  assert.ok(built.tenantId && built.tenantId !== "default", "тенант в ответе — не default");

  // Выход гасит сессию
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: cookieA } });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/voice/agents`, { headers: { cookie: cookieA } });
  assert.equal(afterLogout.status, 401, "старая кука больше не работает");
});

test("dialplan принимает цифровой, +E.164 и пустой provider DID через один handler", async () => {
  const dialplan = await readFile(new URL("../asterisk/extensions.conf", import.meta.url), "utf8");
  assert.match(dialplan, /exten => _X\.,1,Goto\(ascn-inbound-handler,s,1\)/);
  assert.match(dialplan, /exten => _\+X\.,1,Goto\(ascn-inbound-handler,s,1\)/);
  assert.match(dialplan, /exten => s,1,Goto\(ascn-inbound-handler,s,1\)/);
  assert.equal((dialplan.match(/AGI\(agi:\/\/voice-gateway:4573\/register\?tenantId=/g) || []).length, 1, "tenant/connection query собирается только в общем handler");
});

test("запись начинается после регистрации звонка — файл называется по id карточки", async () => {
  const gateway = await readFile(new URL("../voice-gateway/server.mjs", import.meta.url), "utf8");
  const register = gateway.indexOf("await registerCallRecord(meta,");
  const realtime = gateway.indexOf("session = await createRealtimeSession({", register);
  const record = gateway.indexOf("recorder = startRecording(");
  assert.ok(register > 0 && record > 0);
  assert.ok(realtime > register, "callId создаётся до открытия Realtime — первая реплика уже связана с карточкой звонка");
  assert.ok(record > realtime, "запись начинается после регистрации карточки звонка");
  assert.match(gateway, /startRecording\(process\.env\.RECORDINGS_DIR, meta\.callId \|\| ""\)/, "имя файла — строго id карточки звонка");
});

test("gateway передаёт callId для телефонии и сохраняет browser transcripts без него", async () => {
  const gateway = await readFile(new URL("../voice-gateway/server.mjs", import.meta.url), "utf8");
  assert.match(gateway, /postTranscript\(phone, "inbound", event\.transcript \|\| "", runtime\.tenantId \|\| "", callMeta\?\.callId \|\| ""\)/);
  assert.match(gateway, /postTranscript\(phone, "outbound", assistantText, runtime\.tenantId \|\| "", callMeta\?\.callId \|\| ""\)/);
  assert.match(gateway, /direction: "browser",\s+phone,\s+rate: 24000,/);
});
