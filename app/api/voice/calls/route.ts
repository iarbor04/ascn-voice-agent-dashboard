import { createCallRecord, listCallRecords, updateCallRecord } from "@/lib/calls";
import { canonicalPhone, formatDialNumber, getAsteriskEndpoint, normalizeCallVariables, normalizeDialTarget, providerTransport, resolveOutboundRoute } from "@/lib/voice-agents";

export async function GET() {
  return Response.json({ calls: await listCallRecords() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const toNumber = normalizeDialTarget(typeof body?.toNumber === "string" ? body.toNumber : "");
  if (!toNumber) return Response.json({ error: "Укажите корректный номер в формате +7XXXXXXXXXX" }, { status: 400 });
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  const variables = normalizeCallVariables(body?.variables);
  const { agent, connection, settings } = await resolveOutboundRoute(agentId, connectionId);
  if (!agent) return Response.json({ error: "Голосовой агент не найден" }, { status: 404 });
  if (!agent.active) return Response.json({ error: "Голосовой агент выключен" }, { status: 409 });
  if (providerTransport(agent.provider) === "yandex" && (!settings.yandexApiKey || !settings.yandexFolderId)) return Response.json({ error: agent.provider === "deepseek" ? "DeepSeek Realtime работает через Yandex AI Studio — подключите ключ и каталог Yandex" : "Yandex AI Studio не подключена" }, { status: 409 });
  if (agent.provider === "openai" && !settings.openaiApiKey) return Response.json({ error: "OpenAI Realtime не подключён" }, { status: 409 });
  if (agent.provider === "xai" && !settings.xaiApiKey) return Response.json({ error: "xAI Grok Voice не подключён — добавьте ключ xAI" }, { status: 409 });
  if (!connection) return Response.json({ error: "Нет настроенного SIP-номера для исходящих звонков" }, { status: 409 });
  const gatewayUrl = process.env.VOICE_GATEWAY_INTERNAL_URL?.trim();
  if (!gatewayUrl) return Response.json({ error: "VOICE_GATEWAY_INTERNAL_URL не настроен" }, { status: 503 });
  const call = await createCallRecord({ id: crypto.randomUUID(), direction: "outbound", phone: canonicalPhone(toNumber), agentId: agent.id, agentName: agent.name, provider: agent.provider, model: agent.model, variables });
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_API_KEY?.trim() || ""}`, "content-type": "application/json" },
      body: JSON.stringify({ callId: call.id, agentId: agent.id, toNumber: formatDialNumber(toNumber, connection.dialFormat) || toNumber, fromNumber: connection.number || connection.username, endpoint: getAsteriskEndpoint(connection), variables, maxCallSeconds: agent.maxCallSeconds }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || `Voice gateway вернул ${response.status}`);
    return Response.json({ call: await updateCallRecord(call.id, { status: "dialing" }) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось начать звонок";
    return Response.json({ call: await updateCallRecord(call.id, { status: "failed", error: message }), error: message }, { status: 502 });
  }
}
