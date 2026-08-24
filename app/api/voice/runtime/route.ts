import { canonicalPhone, getAsteriskEndpoint, getVoiceSettings, normalizeCallVariables, providerTransport, resolveAgentInstructions, resolveVoiceRoute, type VoiceTool } from "@/lib/voice-agents";
import { createCallRecord, recordCallMetric, ensurePhoneContact, getCallRecord, getContact, listCallMessages, listMessagesSince, rememberPhoneNote, saveCallTranscript, updateCallRecord, updateContactStatus, updatePhoneContact, type CallStatus } from "@/lib/calls";
import { analyzeCallTranscript } from "@/lib/call-analysis";
import { searchKnowledge } from "@/lib/knowledge";
import { sendMail } from "@/lib/mailer";

function authorized(request: Request) {
  const expected = process.env.INTERNAL_API_KEY?.trim();
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

async function buildSession(phone: string, did: string, agentId: string, variables: Record<string, string>) {
  const { agent, connection, settings } = await resolveVoiceRoute(did, agentId || undefined);
  if (!agent) return Response.json({ error: "Нет активного голосового агента" }, { status: 404 });
  if (!agent.active) return Response.json({ error: "Назначенный голосовой агент выключен" }, { status: 409 });
  if (providerTransport(agent.provider) === "yandex" && (!settings.yandexApiKey || !settings.yandexFolderId)) return Response.json({ error: agent.provider === "deepseek" ? "DeepSeek Realtime работает через Yandex AI Studio — подключите ключ и каталог Yandex" : "Yandex AI Studio не подключена" }, { status: 409 });
  if (agent.provider === "openai" && !settings.openaiApiKey) return Response.json({ error: "OpenAI Realtime не подключён" }, { status: 409 });
  if (agent.provider === "xai" && !settings.xaiApiKey) return Response.json({ error: "xAI Grok Voice не подключён — добавьте ключ xAI" }, { status: 409 });
  const contact = await ensurePhoneContact(phone);
  const messages = await listCallMessages(contact.id);
  return Response.json({
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
  const call = await getCallRecord(callId);
  if (!call) return Response.json({ error: "Звонок не найден" }, { status: 404 });
  const updated = await updateCallRecord(callId, { status, error: error.slice(0, 500) });
  if (status !== "ended") return Response.json({ call: updated });
  const messages = await listMessagesSince(`phone:${call.phone.trim() || "unknown"}`, call.createdAt);
  const dialogue = messages.map((message) => `${message.direction === "inbound" ? "Собеседник" : "Агент"}: ${message.text}`).join("\n");
  const purpose = call.variables.caller_purpose ? `Цель звонка: ${call.variables.caller_purpose}\n\n` : "";
  const outcome = await analyzeCallTranscript(call.agentId ? (await resolveVoiceRoute(undefined, call.agentId)).agent?.provider || "yandex" : "yandex", `${purpose}Расшифровка:\n${dialogue}`);
  await notifyByMail(callId, outcome);
  if (outcome) {
    await updateCallRecord(callId, { outcome });
    const note = [outcome.summary, outcome.confirmation && `Подтверждение: ${outcome.confirmation}`, outcome.operator && `Сотрудник: ${outcome.operator}`, outcome.nextStep && `Дальше: ${outcome.nextStep}`].filter(Boolean).join(" · ");
    if (note) await rememberPhoneNote(call.phone, note);
  }
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
  return buildSession(canonicalPhone(url.searchParams.get("phone") || "") || "unknown", url.searchParams.get("did")?.slice(0, 60) || "", url.searchParams.get("agentId") || "", {});
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const phone = canonicalPhone(typeof body?.phone === "string" ? body.phone : "") || "unknown";
  if (body?.action === "session") {
    return buildSession(phone, typeof body.did === "string" ? body.did.slice(0, 60) : "", typeof body.agentId === "string" ? body.agentId : "", normalizeCallVariables(body.variables));
  }
  if (body?.action === "call_started") {
    const direction = body.direction === "outbound" ? "outbound" : "inbound";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const agent = (await resolveVoiceRoute(undefined, agentId || undefined)).agent;
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
    return Response.json({ call: await recordCallMetric(callId, { firstAudioMs, tool, recordedSeconds }) });
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
    if (!text) return Response.json({ error: "Пустая расшифровка" }, { status: 400 });
    return Response.json({ message: await saveCallTranscript(phone, direction, text) });
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
