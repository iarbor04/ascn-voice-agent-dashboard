import { canonicalPhone, getAsteriskEndpoint, getVoiceSettings, normalizeCallVariables, providerTransport, resolveAgentInstructions, resolveInboundRoute, resolveOutboundRoute, resolveVoiceRoute, type VoiceTool } from "@/lib/voice-agents";
import { createCallRecord, recordCallMetric, ensurePhoneContact, getCallRecord, getContact, listCallMessages, listCallTranscript, rememberPhoneNote, saveCallTranscript, transitionCallToTerminal, updateCallRecord, updateContactStatus, updatePhoneContact, type CallStatus } from "@/lib/calls";
import { analyzeCallTranscript } from "@/lib/call-analysis";
import { currentTenantId, DEFAULT_TENANT, withTenant } from "@/lib/tenant-context";
import { searchKnowledge } from "@/lib/knowledge";
import { sendMail } from "@/lib/mailer";

// Шлюз обязан передать тенант, установленный доверенным PJSIP endpoint.
// Поиск владельца по управляемому звонящим DID намеренно запрещён.
function gatewayTenant(explicit: unknown) {
  const claimed = String(explicit || "");
  if (claimed === DEFAULT_TENANT || /^[0-9a-f-]{36}$/i.test(claimed)) return claimed;
  return null;
}

function authorized(request: Request) {
  const expected = process.env.GATEWAY_APP_KEY?.trim();
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

function memoryText(messages: Awaited<ReturnType<typeof listCallMessages>>, notes: string[]) {
  const dialogue = messages.slice(-24).map((message) => `${message.direction === "inbound" ? "Клиент" : "Агент"}: ${message.text}`).join("\n");
  const remembered = notes.length ? `Заметки:\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
  return [remembered, dialogue].filter(Boolean).join("\n\n");
}

function publicTool(tool: VoiceTool) {
  if (tool.type === "ascn") return tool;
  if (tool.type === "mcp" || tool.type === "function") return tool;
  return tool;
}

type SessionDirection = "inbound" | "outbound" | "browser";

async function buildSession(phone: string, did: string, agentId: string, connectionId: string, direction: SessionDirection, variables: Record<string, string>) {
  const route = direction === "inbound"
    ? await resolveInboundRoute(connectionId, did)
    : direction === "outbound"
      ? await resolveOutboundRoute(agentId || undefined, connectionId || undefined)
      : await resolveVoiceRoute(undefined, agentId || undefined);
  const { agent, connection, settings } = route;
  if ((direction === "inbound" || direction === "outbound") && !connection) {
    return Response.json({ error: "SIP-подключение не принадлежит тенанту или DID не совпадает" }, { status: 403 });
  }
  if (!agent) return Response.json({ error: "Нет активного голосового агента" }, { status: 404 });
  if (!agent.active) return Response.json({ error: "Назначенный голосовой агент выключен" }, { status: 409 });
  if (providerTransport(agent.provider) === "yandex" && (!settings.yandexApiKey || !settings.yandexFolderId)) return Response.json({ error: agent.provider === "deepseek" ? "DeepSeek Realtime работает через Yandex AI Studio — подключите ключ и каталог Yandex" : "Yandex AI Studio не подключена" }, { status: 409 });
  if (agent.provider === "openai" && !settings.openaiApiKey) return Response.json({ error: "OpenAI Realtime не подключён" }, { status: 409 });
  if (agent.provider === "xai" && !settings.xaiApiKey) return Response.json({ error: "xAI Grok Voice не подключён — добавьте ключ xAI" }, { status: 409 });
  const contact = await ensurePhoneContact(phone);
  const messages = await listCallMessages(contact.id);
  return Response.json({
    tenantId: currentTenantId(),
    agent: { ...agent, instructions: resolveAgentInstructions(agent, memoryText(messages, contact.notes || []), phone, variables), tools: agent.tools.map(publicTool) },
    ai: providerTransport(agent.provider) === "openai"
      ? { provider: "openai", apiKey: settings.openaiApiKey, projectId: settings.openaiProjectId }
      : providerTransport(agent.provider) === "xai"
        ? { provider: "xai", apiKey: settings.xaiApiKey }
        : { provider: "yandex", apiKey: settings.yandexApiKey, folderId: settings.yandexFolderId },
    telephony: {
      did,
      number: connection?.number || "",
      connectionId: connection?.id || "",
      operatorExtension: connection?.operatorExtension || "",
      endpoint: getAsteriskEndpoint(connection),
    },
    contact,
  });
}

async function finishCall(callId: string, status: CallStatus, error: string) {
  if (status !== "ended" && status !== "failed") return Response.json({ error: "Некорректный финальный статус" }, { status: 400 });
  const transition = await transitionCallToTerminal(callId, status, error);
  const call = transition.call;
  if (!call) return Response.json({ error: "Звонок не найден" }, { status: 404 });
  if (!transition.changed || status !== "ended") return Response.json({ call });
  const messages = await listCallTranscript(callId);
  const dialogue = messages.map((message) => `${message.direction === "inbound" ? "Собеседник" : "Агент"}: ${message.text}`).join("\n");
  const purpose = call.variables.caller_purpose ? `Цель звонка: ${call.variables.caller_purpose}\n\n` : "";
  const outcome = await analyzeCallTranscript(call.agentId ? (await resolveVoiceRoute(undefined, call.agentId)).agent?.provider || "yandex" : "yandex", `${purpose}Расшифровка:\n${dialogue}`);
  if (outcome) {
    await updateCallRecord(callId, { outcome });
    const note = [outcome.summary, outcome.confirmation && `Подтверждение: ${outcome.confirmation}`, outcome.operator && `Сотрудник: ${outcome.operator}`, outcome.nextStep && `Дальше: ${outcome.nextStep}`].filter(Boolean).join(" · ");
    if (note) await rememberPhoneNote(call.phone, note);
  }
  await notifyByMail(callId, outcome);
  return Response.json({ call: await getCallRecord(callId) });
}

// Письмо после звонка: отправляем в фоне, чтобы шлюз не ждал SMTP.
async function notifyByMail(callId: string, outcome: Awaited<ReturnType<typeof analyzeCallTranscript>>) {
  const call = await getCallRecord(callId);
  if (!call) return;
  const route = await resolveVoiceRoute(undefined, call.agentId || undefined);
  const to = route.draft?.notifyEmail || "";
  const settings = await getVoiceSettings(false);
  if (!to || !settings.smtpHost || !settings.smtpFrom) return;
  const seconds = call.endedAt ? Math.round((Date.parse(call.endedAt) - Date.parse(call.createdAt)) / 1000) : 0;
  const body = [
    `Агент: ${call.agentName || "не указан"}`,
    `Номер: ${call.phone}`,
    `Направление: ${call.direction === "outbound" ? "исходящий" : "входящий"}`,
    `Длительность: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    call.variables.caller_purpose ? `Задача: ${call.variables.caller_purpose}` : "",
    "",
    outcome ? (outcome.resolved ? "Задача выполнена." : "Задача не закрыта.") : "Итог разобрать не удалось.",
    outcome?.summary || "",
    outcome?.confirmation ? `Подтверждение: ${outcome.confirmation}` : "",
    outcome?.operator ? `Сотрудник: ${outcome.operator}` : "",
    outcome?.nextStep ? `Дальше: ${outcome.nextStep}` : "",
    call.error ? `Ошибка: ${call.error}` : "",
  ].filter(Boolean).join("\n");
  await sendMail(
    { host: settings.smtpHost, port: settings.smtpPort, user: settings.smtpUser, password: settings.smtpPassword, from: settings.smtpFrom },
    to,
    `Звонок ${call.phone} — ${outcome?.resolved ? "задача выполнена" : "нужно посмотреть"}`,
    body,
  ).catch((error: Error) => console.error("Письмо после звонка не отправлено:", error.message));
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const tenantId = gatewayTenant(url.searchParams.get("tenantId"));
  if (!tenantId) return Response.json({ error: "Шлюз не передал допустимый tenantId" }, { status: 400 });
  const direction: SessionDirection = url.searchParams.get("direction") === "outbound"
    ? "outbound"
    : url.searchParams.get("direction") === "browser" ? "browser" : "inbound";
  return withTenant(tenantId, () => buildSession(
    canonicalPhone(url.searchParams.get("phone") || "") || "unknown",
    url.searchParams.get("did")?.slice(0, 60) || "",
    url.searchParams.get("agentId") || "",
    url.searchParams.get("connectionId") || "",
    direction,
    {},
  ));
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const tenantId = gatewayTenant(body?.tenantId);
  if (!tenantId) return Response.json({ error: "Шлюз не передал допустимый tenantId" }, { status: 400 });
  return withTenant(tenantId, () => handleAction(body, tenantId));
}

async function handleAction(body: Record<string, unknown> | null, tenantId: string) {
  void tenantId;
  const phone = canonicalPhone(typeof body?.phone === "string" ? body.phone : "") || "unknown";
  if (body?.action === "session") {
    const direction: SessionDirection = body.direction === "inbound" || body.direction === "outbound" ? body.direction : "browser";
    return buildSession(
      phone,
      typeof body.did === "string" ? body.did.slice(0, 60) : "",
      typeof body.agentId === "string" ? body.agentId : "",
      typeof body.connectionId === "string" ? body.connectionId : "",
      direction,
      normalizeCallVariables(body.variables),
    );
  }
  if (body?.action === "call_started") {
    const direction = body.direction === "outbound" ? "outbound" : "inbound";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    const did = typeof body.did === "string" ? body.did.slice(0, 60) : "";
    const route = direction === "inbound"
      ? await resolveInboundRoute(connectionId, did)
      : await resolveOutboundRoute(agentId || undefined, connectionId || undefined);
    if (!route.connection) return Response.json({ error: "SIP-подключение не принадлежит тенанту или DID не совпадает" }, { status: 403 });
    const agent = route.agent;
    await ensurePhoneContact(phone);
    const created = await createCallRecord({ id: crypto.randomUUID(), direction, phone, agentId: agent?.id || agentId, agentName: agent?.name || "", provider: agent?.provider || "", model: agent?.model || "", variables: normalizeCallVariables(body.variables) });
    return Response.json({ call: await updateCallRecord(created.id, { status: "live" }) });
  }
  if (body?.action === "call_metric") {
    const callId = typeof body.callId === "string" ? body.callId : "";
    const firstAudioMs = Number(body.firstAudioMs) || 0;
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 80) : "";
    const recordedSeconds = Math.max(0, Number(body.recordedSeconds) || 0);
    if (!callId || (!firstAudioMs && !tool && !recordedSeconds)) return Response.json({ error: "Некорректная метрика звонка" }, { status: 400 });
    const call = await recordCallMetric(callId, { firstAudioMs, tool, recordedSeconds });
    return call
      ? Response.json({ call })
      : Response.json({ error: "Звонок не найден в заявленном tenant" }, { status: 404 });
  }
  if (body?.action === "call_status") {
    const callId = typeof body.callId === "string" ? body.callId : "";
    const allowed: CallStatus[] = ["queued", "dialing", "live", "ended", "failed"];
    const status = allowed.find((item) => item === body.status);
    if (!callId || !status) return Response.json({ error: "Некорректный статус звонка" }, { status: 400 });
    return finishCall(callId, status, typeof body.error === "string" ? body.error : "");
  }
  await ensurePhoneContact(phone);
  if (body?.action === "transcript") {
    const direction = body.direction === "outbound" ? "outbound" : "inbound";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 10000) : "";
    const callId = typeof body.callId === "string" && body.callId
      ? body.callId.toLowerCase()
      : null;
    if (!text) return Response.json({ error: "Пустая расшифровка" }, { status: 400 });
    if (callId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(callId)) {
      return Response.json({ error: "Некорректный callId" }, { status: 400 });
    }
    const message = await saveCallTranscript(phone, direction, text, callId);
    return message
      ? Response.json({ message })
      : Response.json({ error: "Звонок не найден для указанного номера и tenant" }, { status: 404 });
  }
  if (body?.action !== "tool" || typeof body.name !== "string") return Response.json({ error: "Неизвестное действие" }, { status: 400 });
  const args = body.arguments && typeof body.arguments === "object" ? body.arguments as Record<string, unknown> : {};
  const contactId = `phone:${phone.trim() || "unknown"}`;
  switch (body.name) {
    case "ascn_contact_context": {
      const [contact, messages] = await Promise.all([getContact(contactId), listCallMessages(contactId)]);
      return Response.json({ contact, recentMessages: messages.slice(-20), statuses: ["new", "qualified", "resolved"] });
    }
    case "ascn_update_contact":
      return Response.json({ contact: await updatePhoneContact(phone, { name: String(args.name || ""), language: String(args.language || "") }) });
    case "ascn_move_pipeline": {
      const stageId = String(args.stage_id || "");
      const statuses = ["new", "qualified", "resolved"];
      if (!statuses.includes(stageId)) return Response.json({ error: "Статус не найден", statuses }, { status: 400 });
      return Response.json({ ok: await updateContactStatus(phone, stageId) });
    }
    case "ascn_remember_note":
      return Response.json({ notes: await rememberPhoneNote(phone, String(args.note || "")) });
    case "ascn_search_knowledge": {
      const query = String(args.query || "").slice(0, 300);
      const agent = (await resolveVoiceRoute(undefined, typeof body.agentId === "string" ? body.agentId : undefined)).agent;
      const found = searchKnowledge(agent?.knowledge || [], query, 5, agent?.pronunciations || []);
      return Response.json({
        found,
        note: found.length
          ? "Это куски из базы знаний, а не готовый ответ. Если они не отвечают на вопрос клиента — скажи, что уточнишь, и не додумывай."
          : "В базе знаний ничего не найдено — не выдумывай ответ, предложи уточнить у сотрудника.",
      });
    }
    default:
      return Response.json({ error: "Инструмент не поддерживается приложением" }, { status: 404 });
  }
}
