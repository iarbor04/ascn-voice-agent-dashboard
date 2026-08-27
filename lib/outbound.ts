import { createCallRecord, type CallRecord, updateCallRecord } from "./calls.ts";
import { currentTenantId } from "./tenant-context.ts";
import {
  canonicalPhone,
  formatDialNumber,
  getAsteriskEndpoint,
  normalizeCallVariables,
  normalizeDialTarget,
  providerTransport,
  resolveOutboundRoute,
} from "./voice-agents.ts";

export class OutboundCallError extends Error {
  status: number;
  call?: CallRecord | null;

  constructor(message: string, status: number, call?: CallRecord | null) {
    super(message);
    this.name = "OutboundCallError";
    this.status = status;
    this.call = call;
  }
}

export type OutboundCallInput = {
  callId?: string;
  toNumber: string;
  agentId?: string;
  connectionId?: string;
  variables?: unknown;
};

export async function dispatchOutboundCall(input: OutboundCallInput) {
  const toNumber = normalizeDialTarget(input.toNumber);
  if (!toNumber) throw new OutboundCallError("Укажите корректный номер в формате +7XXXXXXXXXX", 400);
  const variables = normalizeCallVariables(input.variables);
  const { agent, connection, settings } = await resolveOutboundRoute(input.agentId || "", input.connectionId || "");
  if (!agent) throw new OutboundCallError("Голосовой агент не найден", 404);
  if (!agent.active) throw new OutboundCallError("Голосовой агент выключен", 409);
  if (providerTransport(agent.provider) === "yandex" && (!settings.yandexApiKey || !settings.yandexFolderId)) {
    throw new OutboundCallError(agent.provider === "deepseek"
      ? "DeepSeek Realtime работает через Yandex AI Studio — подключите ключ и каталог Yandex"
      : "Yandex AI Studio не подключена", 409);
  }
  if (agent.provider === "openai" && !settings.openaiApiKey) throw new OutboundCallError("OpenAI Realtime не подключён", 409);
  if (agent.provider === "xai" && !settings.xaiApiKey) throw new OutboundCallError("xAI Grok Voice не подключён — добавьте ключ xAI", 409);
  if (!connection) throw new OutboundCallError("Нет настроенного SIP-номера для исходящих звонков", 409);

  const gatewayUrl = process.env.VOICE_GATEWAY_INTERNAL_URL?.trim();
  if (!gatewayUrl) throw new OutboundCallError("VOICE_GATEWAY_INTERNAL_URL не настроен", 503);
  const gatewayKey = process.env.APP_GATEWAY_KEY?.trim();
  if (!gatewayKey) throw new OutboundCallError("APP_GATEWAY_KEY не настроен", 503);

  const call = await createCallRecord({
    id: input.callId || crypto.randomUUID(),
    direction: "outbound",
    phone: canonicalPhone(toNumber),
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    model: agent.model,
    variables,
  });
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        callId: call.id,
        tenantId: currentTenantId(),
        agentId: agent.id,
        connectionId: connection.id,
        toNumber: formatDialNumber(toNumber, connection.dialFormat) || toNumber,
        fromNumber: connection.number || connection.username,
        endpoint: getAsteriskEndpoint(connection),
        variables,
        maxCallSeconds: agent.maxCallSeconds,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || `Voice gateway вернул ${response.status}`);
    return await updateCallRecord(call.id, { status: "dialing" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось начать звонок";
    const failedCall = await updateCallRecord(call.id, { status: "failed", error: message });
    throw new OutboundCallError(message, 502, failedCall);
  }
}
