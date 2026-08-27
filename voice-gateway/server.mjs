import http from "node:http";
import net from "node:net";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import WebSocket, { WebSocketServer } from "ws";
import { applyGain, resamplePcm16 } from "./audio.mjs";
import { archiveRecordingFile, commitRecordingArchive, prepareRecordingArchive, startRecordingSpoolRetryWorker } from "./object-storage.mjs";
import { postPublicWebhook } from "./public-webhook.mjs";
import { startRecording } from "./recorder.mjs";

const port = Number(process.env.PORT || 8787);
const appUrl = (process.env.ASCN_APP_URL || "http://app:3000").replace(/\/$/, "");

function requiredSecret(name, minimumBytes = 32) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  if (Buffer.byteLength(value) < minimumBytes) throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
  return value;
}

function configuredInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const gatewayAppKey = requiredSecret("GATEWAY_APP_KEY");
const appGatewayKey = requiredSecret("APP_GATEWAY_KEY");
const browserTokenSecret = requiredSecret("BROWSER_TOKEN_SECRET");
const amiPassword = requiredSecret("AMI_PASSWORD");
if (new Set([gatewayAppKey, appGatewayKey, browserTokenSecret]).size !== 3) {
  throw new Error("GATEWAY_APP_KEY, APP_GATEWAY_KEY and BROWSER_TOKEN_SECRET must all be different");
}
const maxBrowserSessions = configuredInteger("MAX_BROWSER_SESSIONS", 5, 1, 100);
const maxActiveCalls = configuredInteger("MAX_ACTIVE_CALLS", 50, 1, 500);
const capacityLeaseMs = configuredInteger("CALL_CAPACITY_LEASE_MS", 120_000, 30_000, 600_000);
const terminalOutboxIntervalMs = configuredInteger("TERMINAL_OUTBOX_INTERVAL_MS", 5_000, 1_000, 60_000);
const terminalOutboxClaimMs = configuredInteger("TERMINAL_OUTBOX_CLAIM_MS", 600_000, 60_000, 1_800_000);
const terminalOutboxConcurrency = configuredInteger("TERMINAL_OUTBOX_CONCURRENCY", 2, 1, 8);
const terminalDeadLetterTtlMs = configuredInteger("TERMINAL_OUTBOX_DEAD_LETTER_TTL_MS", 2_592_000_000, 86_400_000, 7_776_000_000);
const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) throw new Error("REDIS_URL must be configured");
const redis = createClient({ url: redisUrl });
redis.on("error", (error) => console.error("[voice-gateway] Redis error", error.message));
await redis.connect();

const liveCalls = new Map();
const startingCalls = new Set();
const pendingKey = (callId) => `ascn:voice:pending:${callId}`;
// Hash tags keep every multi-key script in one Redis Cluster slot as the
// gateway is scaled horizontally.
const capacityKey = "ascn:voice:{capacity}:leases";
const capacityLeaseKey = (callId) => `ascn:voice:{capacity}:lease:${callId}`;
const terminalOutboxKey = "ascn:voice:{status-outbox}:schedule";
const terminalEventKey = (callId) => `ascn:voice:{status-outbox}:event:${callId}`;
const terminalDeadLetterKey = (callId) => `ascn:voice:{status-outbox}:dead:${callId}`;

const ACQUIRE_CAPACITY_SCRIPT = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local expires = now + tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local owner = redis.call('GET', KEYS[2])
if owner then
  if owner ~= ARGV[2] then return -1 end
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[1], expires, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1`;

const RENEW_CAPACITY_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1`;

const RELEASE_CAPACITY_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1`;

const ENQUEUE_TERMINAL_EVENT_SCRIPT = `
if redis.call('GET', KEYS[2]) then return 0 end
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[1], now, ARGV[1])
return 1`;

const CLAIM_TERMINAL_EVENTS_SCRIPT = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[1]))
for _, id in ipairs(ids) do
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), id)
end
return ids`;

const ACK_TERMINAL_EVENT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1`;

const RESCHEDULE_TERMINAL_EVENT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('SET', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), ARGV[1])
return 1`;

const DEAD_LETTER_TERMINAL_EVENT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[4])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1`;

class CallAdmissionError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.name = "CallAdmissionError";
    this.httpStatus = httpStatus;
  }
}

async function setPendingCall(callId, value) {
  // Metadata нужна лишь до захвата AudioSocket; после старта звонка ключ удаляется.
  // Короткий TTL не позволяет сильно запоздавшему Originate воскресить failed call.
  await redis.set(pendingKey(callId), JSON.stringify(value), { EX: 600 });
}

async function getPendingCall(callId) {
  const raw = await redis.get(pendingKey(callId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { await redis.del(pendingKey(callId)); return null; }
}

async function takePendingCall(callId) {
  const raw = await redis.getDel(pendingKey(callId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function deletePendingCall(callId) {
  if (callId) await redis.del(pendingKey(callId));
}

async function acquireCallCapacity(callId, token) {
  let result;
  try {
    result = Number(await redis.eval(ACQUIRE_CAPACITY_SCRIPT, {
      keys: [capacityKey, capacityLeaseKey(callId)],
      arguments: [callId, token, String(capacityLeaseMs), String(maxActiveCalls)],
    }));
  } catch (error) {
    log("capacity reservation failed", error instanceof Error ? error.message : String(error));
    throw new CallAdmissionError("Сервис распределения звонков временно недоступен", 503);
  }
  if (result === 0) throw new CallAdmissionError("Достигнут лимит одновременных звонков", 429);
  if (result === -1) throw new CallAdmissionError("Этот звонок уже обрабатывается", 409);
  if (result !== 1) throw new CallAdmissionError("Не удалось зарезервировать ёмкость звонка", 503);
  return true;
}

async function renewCallCapacity(callId, token) {
  return Number(await redis.eval(RENEW_CAPACITY_SCRIPT, {
    keys: [capacityKey, capacityLeaseKey(callId)],
    arguments: [callId, token, String(capacityLeaseMs)],
  })) === 1;
}

async function releaseCallCapacity(callId, token) {
  if (!callId || !token) return false;
  return Number(await redis.eval(RELEASE_CAPACITY_SCRIPT, {
    keys: [capacityKey, capacityLeaseKey(callId)],
    arguments: [callId, token],
  })) === 1;
}

async function waitForTerminalOutboxDurability() {
  // Redis AOF is the write-ahead log for terminal events. WAITAOF makes an
  // accepted enqueue fail closed until the local append-only file is fsynced.
  const result = await redis.sendCommand(["WAITAOF", "1", "0", "2000"]);
  const localAofCopies = Array.isArray(result) ? Number(result[0]) : 0;
  if (localAofCopies < 1) throw new Error("Redis did not fsync the terminal-status outbox");
}

async function enqueueTerminalStatus(callId, status, error = "", tenantId = "") {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) throw new Error("Invalid terminal-status call id");
  if (status !== "ended" && status !== "failed") throw new Error("Invalid terminal status");
  if (tenantId !== "default" && !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("Invalid terminal-status tenant id");
  const event = JSON.stringify({
    version: 1,
    callId,
    tenantId,
    status,
    error: String(error || "").slice(0, 500),
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  await redis.eval(ENQUEUE_TERMINAL_EVENT_SCRIPT, {
    keys: [terminalOutboxKey, terminalEventKey(callId)],
    arguments: [callId, event],
  });
  await waitForTerminalOutboxDurability();
  return event;
}

// Токен: agentId.tenantId.expiresAt.signature — тенант возвращаем строкой.
async function validBrowserToken(token, agentId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== agentId) return null;
  if (parts[1] !== "default" && !/^[0-9a-f-]{36}$/i.test(parts[1])) return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  const expected = createHmac("sha256", browserTokenSecret).update(`${parts[0]}.${parts[1]}.${parts[2]}`).digest("base64url");
  const actualBuffer = Buffer.from(parts[3]);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  const tokenHash = createHash("sha256").update(String(token)).digest("hex");
  const consumed = await redis.set(`ascn:voice:browser-token:${tokenHash}`, "1", { EX: ttl, NX: true });
  return consumed === "OK" ? parts[1] : null;
}

function log(message, details = "") {
  console.log(`[voice-gateway] ${message}${details ? ` ${details}` : ""}`);
}

async function appRequest(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${gatewayAppKey}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `ASCN returned ${response.status}`);
  return body;
}

function toolDefinition(tool, provider) {
  if (provider === "xai") {
    if (tool.type === "web_search") return { type: "web_search" };
    // mcp xAI принимает (проверено живой сессией 24.08.2026); file_search — нет.
    if (tool.type === "file_search") return null;
  }
  if (provider === "openai" && (tool.type === "web_search" || tool.type === "file_search")) return null;
  if (tool.type === "dtmf") return { type: "function", name: "ascn_press_digit", description: "Набрать цифры в тональном меню (IVR). Допустимы 0-9, * и #. Используй, чтобы пройти автоответчик и дойти до живого сотрудника.", parameters: { type: "object", properties: { digits: { type: "string", description: "Цифры подряд, например 2 или 1#" } }, required: ["digits"], additionalProperties: false } };
  if (tool.type === "web_search") return { type: "function", name: "web_search", description: "Поиск в интернете", parameters: {} };
  if (tool.type === "file_search") return { type: "function", name: "file_search", description: tool.vectorStoreId, parameters: {} };
  if (tool.type === "mcp") {
    // require_approval всегда never: подтверждать вызов в телефонном звонке
    // некому, "always" повесил бы разговор в тишину до таймаута.
    const definition = { type: "mcp", server_label: tool.label, server_url: tool.url, require_approval: "never" };
    if (tool.authorization) definition.authorization = tool.authorization;
    if (Array.isArray(tool.allowedTools) && tool.allowedTools.length) definition.allowed_tools = tool.allowedTools;
    return definition;
  }
  if (tool.type === "function") return { type: "function", name: tool.name, description: tool.description, parameters: JSON.parse(tool.parameters || "{}") };
  const definitions = {
    contact_context: { name: "ascn_contact_context", description: "Получить карточку клиента, историю сообщений и этапы воронки ASCN.", parameters: { type: "object", properties: {}, additionalProperties: false } },
    update_contact: { name: "ascn_update_contact", description: "Сохранить имя или язык клиента в ASCN CRM.", parameters: { type: "object", properties: { name: { type: "string" }, language: { type: "string" } }, additionalProperties: false } },
    move_pipeline: { name: "ascn_move_pipeline", description: "Переместить клиента на указанный этап воронки ASCN.", parameters: { type: "object", properties: { stage_id: { type: "string" } }, required: ["stage_id"], additionalProperties: false } },
    remember_note: { name: "ascn_remember_note", description: "Запомнить важный факт о клиенте для следующих звонков.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } },
    transfer_call: { name: "ascn_transfer_call", description: "Перевести текущий телефонный звонок живому оператору.", parameters: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false } },
    search_knowledge: { name: "ascn_search_knowledge", description: "Найти ответ в базе знаний агента: каталог, наличие, цены, правила доставки и возврата. Используй прежде, чем сказать «не знаю».", parameters: { type: "object", properties: { query: { type: "string", description: "Что искать, словами клиента" } }, required: ["query"], additionalProperties: false } },
    end_call: { name: "ascn_end_call", description: "Корректно завершить текущий телефонный звонок.", parameters: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false } },
  };
  return { type: "function", ...definitions[tool.name] };
}

function sessionPayload(runtime, rate) {
  const agent = runtime.agent;
  const provider = runtime.ai.provider;
  if (provider === "xai") {
    const tempo = Number(agent.speed) || 1;
    const tempoLine = tempo > 1.05 ? "\n\nГовори заметно бодрее и быстрее обычного, без пауз между фразами."
      : tempo < 0.95 ? "\n\nГовори медленнее обычного, спокойно и размеренно, с паузами."
      : "";
    return {
      type: "session.update",
      session: {
        instructions: agent.instructions + tempoLine,
        modalities: agent.synthesisEnabled ? ["audio"] : ["text"],
        voice: agent.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1", ...(agent.recognitionLanguage && agent.recognitionLanguage !== "auto" ? { language: agent.recognitionLanguage.split("-")[0] } : {}) },
        ...(agent.vadEnabled ? { turn_detection: { type: "server_vad", threshold: agent.vadThreshold, silence_duration_ms: agent.silenceDurationMs } } : {}),
        tools: agent.tools.map((tool) => toolDefinition(tool, provider)).filter(Boolean),
        tool_choice: "auto",
      },
    };
  }
  const upstreamRate = provider === "openai" ? 24000 : rate;
  const input = {
    format: { type: "audio/pcm", rate: upstreamRate },
    ...(provider === "yandex" && agent.recognitionLanguage !== "auto" ? { languages: [agent.recognitionLanguage] } : {}),
    ...(provider === "openai" ? { transcription: { model: "gpt-live-transcribe", ...(agent.recognitionLanguage && agent.recognitionLanguage !== "auto" ? { language: agent.recognitionLanguage.split("-")[0] } : {}) } } : {}),
    ...(agent.vadEnabled ? { turn_detection: { type: "server_vad", threshold: agent.vadThreshold, silence_duration_ms: agent.silenceDurationMs } } : {}),
  };
  const tools = agent.tools.map((tool) => toolDefinition(tool, provider)).filter(Boolean);
  if (provider === "openai") {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: agent.model,
        instructions: agent.instructions,
        output_modalities: agent.synthesisEnabled ? ["audio"] : ["text"],
        audio: {
          input,
          output: { format: { type: "audio/pcm" }, voice: agent.voice, speed: Math.min(1.5, Math.max(0.25, Number(agent.speed) || 1)) },
        },
        tools,
      },
    };
  }
  return {
    type: "session.update",
    session: {
      instructions: agent.instructions,
      output_modalities: agent.synthesisEnabled ? ["audio"] : ["text"],
      audio: {
        input,
        output: { format: { type: "audio/pcm", rate }, voice: agent.voice, ...(agent.role ? { role: agent.role } : {}), speed: agent.speed },
      },
      tools,
    },
  };
}

async function postTranscript(phone, direction, text, tenantId = "", callId = "") {
  if (!text?.trim()) return;
  await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "transcript", phone, direction, text, tenantId, ...(callId ? { callId } : {}) }) }).catch((error) => log("transcript save failed", error.message));
}

function postCallMetric(callId, metric, tenantId = "") {
  if (!callId) return;
  appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "call_metric", callId, tenantId, ...metric }) }).catch((problem) => log("call metric failed", problem.message));
}

async function acknowledgeRecording(job) {
  const result = await appRequest("/api/voice/runtime", {
    method: "POST",
    body: JSON.stringify({
      action: "call_metric",
      callId: job.callId,
      tenantId: job.tenantId,
      recordedSeconds: job.recordedSeconds,
    }),
  });
  if (result.call?.id !== job.callId || Number(result.call.recordedSeconds) < Math.round(job.recordedSeconds)) {
    throw new Error("ASCN did not acknowledge the recording metric");
  }
  return result;
}

async function postCallStatus(callId, status, error = "", tenantId = "") {
  if (!callId) throw new Error("Call id is required for a status update");
  const result = await appRequest("/api/voice/runtime", {
    method: "POST",
    body: JSON.stringify({ action: "call_status", callId, status, error, tenantId }),
    signal: (status === "ended" || status === "failed")
      ? AbortSignal.timeout(Math.min(300_000, Math.max(10_000, terminalOutboxClaimMs - 5_000)))
      : undefined,
  });
  const terminalAcknowledged = (status === "ended" || status === "failed")
    && (result.call?.status === "ended" || result.call?.status === "failed");
  if (result.call?.id !== callId || (!terminalAcknowledged && result.call?.status !== status)) {
    throw new Error(`ASCN did not acknowledge call status ${status}`);
  }
  return result.call;
}

async function registerCallRecord(meta, direction) {
  if (meta.callId) return meta.callId;
  const body = await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "call_started", direction, phone: meta.phone, agentId: meta.agentId || "", tenantId: meta.tenantId || "", connectionId: meta.connectionId || "", did: meta.did || "" }) });
  if (!/^[0-9a-f-]{36}$/i.test(body.call?.id || "") || body.call?.status !== "live") {
    throw new Error("ASCN did not create a live call record");
  }
  meta.callId = body.call.id;
  return meta.callId;
}

async function deadLetterTerminalStatus(callId, raw, reason) {
  const deadLetter = JSON.stringify({
    version: 1,
    callId,
    reason: String(reason || "invalid terminal event").slice(0, 300),
    original: String(raw || "").slice(0, 4096),
    deadLetteredAt: new Date().toISOString(),
  });
  const moved = Number(await redis.eval(DEAD_LETTER_TERMINAL_EVENT_SCRIPT, {
    keys: [terminalOutboxKey, terminalEventKey(callId), terminalDeadLetterKey(callId)],
    arguments: [callId, raw, deadLetter, String(terminalDeadLetterTtlMs)],
  }));
  if (moved === 1) {
    await waitForTerminalOutboxDurability();
    log("terminal outbox event dead-lettered", callId);
  }
}

async function deliverTerminalStatusEvent(callId) {
  const eventKey = terminalEventKey(callId);
  const raw = await redis.get(eventKey);
  if (!raw) {
    await redis.zRem(terminalOutboxKey, callId);
    return;
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    await deadLetterTerminalStatus(callId, raw, "terminal event is not valid JSON");
    return;
  }
  if (event?.version !== 1 || event.callId !== callId
    || (event.status !== "ended" && event.status !== "failed")
    || (event.tenantId !== "default" && !/^[0-9a-f-]{36}$/i.test(event.tenantId || ""))) {
    await deadLetterTerminalStatus(callId, raw, "terminal event failed schema or tenant validation");
    return;
  }
  try {
    await postCallStatus(event.callId, event.status, event.error || "", event.tenantId);
    const acknowledged = Number(await redis.eval(ACK_TERMINAL_EVENT_SCRIPT, {
      keys: [terminalOutboxKey, eventKey],
      arguments: [callId, raw],
    }));
    if (acknowledged === 1) log("terminal status delivered", `${callId} ${event.status}`);
  } catch (error) {
    const attempts = Math.min(10_000, Math.max(0, Number(event.attempts) || 0) + 1);
    const delayMs = Math.min(300_000, 1_000 * (2 ** Math.min(attempts - 1, 8)));
    const updated = JSON.stringify({
      ...event,
      attempts,
      lastError: String(error instanceof Error ? error.message : error).slice(0, 300),
      lastAttemptAt: new Date().toISOString(),
    });
    await redis.eval(RESCHEDULE_TERMINAL_EVENT_SCRIPT, {
      keys: [terminalOutboxKey, eventKey],
      arguments: [callId, raw, updated, String(delayMs)],
    });
    log("terminal status delivery deferred", `${callId} attempt=${attempts}`);
  }
}

let terminalOutboxDraining = false;
let terminalOutboxDrainAgain = false;

async function drainTerminalStatusOutbox() {
  if (terminalOutboxDraining) {
    terminalOutboxDrainAgain = true;
    return;
  }
  terminalOutboxDraining = true;
  try {
    do {
      terminalOutboxDrainAgain = false;
      let claimed;
      do {
        claimed = await redis.eval(CLAIM_TERMINAL_EVENTS_SCRIPT, {
          keys: [terminalOutboxKey],
          arguments: [String(terminalOutboxConcurrency), String(terminalOutboxClaimMs)],
        });
        const callIds = Array.isArray(claimed) ? claimed.map(String) : [];
        await Promise.all(callIds.map((id) => deliverTerminalStatusEvent(id)));
        if (callIds.length < terminalOutboxConcurrency) break;
      } while (redis.isReady);
    } while (terminalOutboxDrainAgain && redis.isReady);
  } finally {
    terminalOutboxDraining = false;
  }
}

function kickTerminalStatusOutbox() {
  void drainTerminalStatusOutbox().catch((error) => log("terminal outbox drain failed", error.message));
}

function ambientBed(kind, rate) {
  const samples = rate * 4;
  const bed = new Int16Array(samples);
  const cutoff = kind === "street" ? 0.05 : kind === "cafe" ? 0.13 : 0.22;
  const amplitude = kind === "street" ? 11000 : kind === "cafe" ? 9000 : 6000;
  let low = 0;
  for (let index = 0; index < samples; index += 1) {
    low += cutoff * ((Math.random() * 2 - 1) - low);
    const fade = Math.min(1, Math.min(index, samples - index) / (rate * 0.25));
    bed[index] = Math.max(-32768, Math.min(32767, Math.round(low * amplitude * fade)));
  }
  return Buffer.from(bed.buffer);
}

function mixAmbient(frame, bed, position, volume) {
  const bedSamples = Math.floor(bed.length / 2);
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const bedIndex = ((position / 2 + offset / 2) % bedSamples) * 2;
    const mixed = frame.readInt16LE(offset) + Math.round(bed.readInt16LE(bedIndex) * volume);
    frame.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), offset);
  }
  return frame;
}

function amiAction(fields) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: process.env.ASTERISK_HOST || "asterisk", port: 5038 });
    let output = "";
    socket.setTimeout(3000);
    socket.on("connect", () => {
      const actions = [
        { Action: "Login", Username: "ascn", Secret: amiPassword, Events: "off" },
        ...(Array.isArray(fields) ? fields : [fields]),
        { Action: "Logoff" },
      ];
      socket.write(actions.map((action) => `${Object.entries(action).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`).join(""));
    });
    socket.on("data", (chunk) => { output += chunk.toString(); });
    socket.on("end", () => resolve(output));
    socket.on("timeout", () => { socket.destroy(); reject(new Error("AMI timeout")); });
    socket.on("error", reject);
  });
}

async function executeTool(runtime, phone, callMeta, toolName, args) {
  if (toolName === "ascn_transfer_call") {
    if (!callMeta?.channel || !runtime.telephony.operatorExtension) throw new Error("Перевод доступен только для SIP-звонка с настроенным номером оператора");
    const actions = [];
    if (runtime.telephony.endpoint) actions.push({ Action: "Setvar", Channel: callMeta.channel, Variable: "ASCN_ENDPOINT", Value: runtime.telephony.endpoint });
    actions.push({ Action: "Redirect", Channel: callMeta.channel, Context: "ascn-transfer", Exten: runtime.telephony.operatorExtension, Priority: "1" });
    await amiAction(actions);
    return { ok: true, message: "Звонок переводится оператору" };
  }
  if (toolName === "ascn_press_digit") {
    if (!callMeta?.channel) throw new Error("Тональный набор доступен только для телефонного звонка");
    const digits = String(args.digits || "").replace(/[^0-9*#]/g, "").slice(0, 20);
    if (!digits) throw new Error("Нечего набирать");
    await amiAction([...digits].map((digit) => ({ Action: "PlayDTMF", Channel: callMeta.channel, Digit: digit, Duration: 150 })));
    return { ok: true, pressed: digits };
  }
  if (toolName === "ascn_end_call") {
    if (!callMeta?.channel) throw new Error("Завершение доступно только для SIP-звонка");
    await amiAction({ Action: "Hangup", Channel: callMeta.channel, Cause: "16" });
    return { ok: true };
  }
  const custom = runtime.agent.tools.find((tool) => tool.type === "function" && tool.name === toolName);
  if (custom) {
    return postPublicWebhook(custom.webhookUrl, {
      authorization: custom.authorization,
      payload: { arguments: args, caller: phone },
      timeoutMs: 15_000,
    });
  }
  return appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "tool", tenantId: runtime.tenantId || "", phone, name: toolName, arguments: args, agentId: runtime.agent.id }) });
}

async function createRealtimeSession({ agentId, tenantId, connectionId, direction, phone, did, rate, callMeta, variables, onEvent, onAudio, onClose }) {
  const runtime = await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "session", direction: direction || "browser", phone, did: did || "", agentId: agentId || "", tenantId: tenantId || "", connectionId: connectionId || "", variables: variables || {} }) });
  const isOpenAi = runtime.ai.provider === "openai";
  const isXai = runtime.ai.provider === "xai";
  const upstreamRate = isOpenAi || isXai ? 24000 : rate;
  const endpoint = isOpenAi
    ? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(runtime.agent.model)}`
    : isXai
      ? `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(runtime.agent.model)}`
      : `wss://ai.api.cloud.yandex.net/v1/realtime?model=${encodeURIComponent(`gpt://${runtime.ai.folderId}/${runtime.agent.model}`)}`;
  const headers = isOpenAi
    ? { Authorization: `Bearer ${runtime.ai.apiKey}`, ...(runtime.ai.projectId ? { "OpenAI-Project": runtime.ai.projectId } : {}) }
    : isXai
      ? { Authorization: `Bearer ${runtime.ai.apiKey}` }
      : { Authorization: `Api-Key ${runtime.ai.apiKey}` };
  const upstream = new WebSocket(endpoint, { headers });
  let assistantText = "";
  let started = false;
  let activeResponseId = "";
  let followUpTimer;
  const savedTranscripts = new Set();

  // Собеседник замолчал после реплики агента — просим модель заговорить снова.
  function armFollowUp() {
    clearTimeout(followUpTimer);
    const seconds = Number(runtime.agent.followUpSeconds) || 0;
    if (!seconds) return;
    followUpTimer = setTimeout(() => {
      if (upstream.readyState !== WebSocket.OPEN || activeResponseId) return;
      const nudge = runtime.agent.followUpMessage || "Собеседник молчит. Коротко переспроси, слышно ли тебя, и предложи помощь.";
      upstream.send(JSON.stringify({ type: "response.create", response: { instructions: nudge } }));
    }, seconds * 1000);
  }
  upstream.on("open", () => upstream.send(JSON.stringify(sessionPayload(runtime, rate))));
  upstream.on("message", async (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === "session.created" || event.type === "session.updated") {
      if (!started && runtime.agent.speaksFirst) {
        started = true;
        upstream.send(JSON.stringify({ type: "response.create", response: runtime.agent.firstMessage ? { instructions: `Начни разговор этой фразой: ${runtime.agent.firstMessage}` } : undefined }));
      }
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcriptKey = event.item_id || event.event_id || "";
      if (!transcriptKey || !savedTranscripts.has(transcriptKey)) {
        if (transcriptKey) {
          if (savedTranscripts.size > 500) savedTranscripts.clear();
          savedTranscripts.add(transcriptKey);
        }
        await postTranscript(phone, "inbound", event.transcript || "", runtime.tenantId || "", callMeta?.callId || "");
      } else log("повторная расшифровка отброшена", transcriptKey);
    }
    if (event.type === "response.created") activeResponseId = event.response?.id || "";
    if (event.type === "input_audio_buffer.speech_started") clearTimeout(followUpTimer);
    if (event.type === "input_audio_buffer.speech_started" && runtime.agent.allowInterruptions !== false && activeResponseId && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "response.cancel", response_id: activeResponseId }));
    }
    if (event.type === "response.output_text.delta" || event.type === "response.output_audio_transcript.delta" || event.type === "response.text.delta" || event.type === "response.audio_transcript.delta") assistantText += event.delta || "";
    if (event.type === "response.done" && assistantText) {
      await postTranscript(phone, "outbound", assistantText, runtime.tenantId || "", callMeta?.callId || "");
      assistantText = "";
    }
    if (event.type === "response.done") {
      activeResponseId = "";
      armFollowUp();
    }
    if (event.type === "response.output_audio.delta" && event.delta) onAudio?.(resamplePcm16(Buffer.from(event.delta, "base64"), upstreamRate, rate));
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      let output;
      try {
        const args = JSON.parse(event.item.arguments || "{}");
        output = await executeTool(runtime, phone, callMeta, event.item.name, args);
        postCallMetric(callMeta?.callId, { tool: event.item.name }, runtime.tenantId || "");
      } catch (error) {
        output = { error: error instanceof Error ? error.message : "Tool failed" };
      }
      upstream.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.item.call_id, output: JSON.stringify(output) } }));
      upstream.send(JSON.stringify({ type: "response.create" }));
    }
    onEvent?.(event);
  });
  upstream.on("error", (error) => onEvent?.({ type: "error", error: { message: error.message } }));
  upstream.on("close", () => { clearTimeout(followUpTimer); onClose?.(); });
  return {
    runtime,
    upstream,
    sendAudio(audio) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: resamplePcm16(audio, rate, upstreamRate).toString("base64") }));
    },
  };
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; if (raw.length > 200000) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    request.on("error", () => resolve(null));
  });
}

async function startOutboundCall(body) {
  const callId = String(body.callId || "");
  const toNumber = String(body.toNumber || "").replace(/[^0-9+]/g, "").slice(0, 21);
  const endpoint = String(body.endpoint || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const tenantId = String(body.tenantId || "");
  const agentId = String(body.agentId || "");
  const connectionId = String(body.connectionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(callId) || !toNumber || !endpoint
    || (tenantId !== "default" && !/^[0-9a-f-]{36}$/i.test(tenantId))
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) throw new Error("Некорректные параметры звонка");
  const capacityLeaseToken = randomUUID();
  await acquireCallCapacity(callId, capacityLeaseToken);
  try {
    await setPendingCall(callId, {
      phone: toNumber,
      did: "",
      channel: "",
      callId,
      agentId,
      tenantId,
      connectionId,
      capacityLeaseToken,
      variables: body.variables && typeof body.variables === "object" ? body.variables : {},
      maxCallSeconds: Number(body.maxCallSeconds) || 0,
      direction: "outbound",
    });
    const result = await amiAction({
      Action: "Originate",
      Channel: `PJSIP/${toNumber}@${endpoint}`,
      Context: "ascn-outbound",
      Exten: "s",
      Priority: 1,
      Timeout: 45000,
      CallerID: String(body.fromNumber || "").replace(/[^0-9+]/g, "").slice(0, 21),
      Async: "true",
      Variable: `ASCN_CALL_UUID=${callId}`,
    });
    if (/Response:\s*Error/i.test(result)) throw new Error(result.split(/\r?\n/).find((line) => /^Message:/i.test(line))?.replace(/^Message:\s*/i, "") || "Asterisk отклонил звонок");
    log("outbound call started", `${toNumber} via ${endpoint}`);
    return { ok: true, callId };
  } catch (error) {
    await Promise.allSettled([
      deletePendingCall(callId),
      releaseCallCapacity(callId, capacityLeaseToken),
    ]);
    throw error;
  }
}

const httpServer = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    if (!redis.isReady) { response.writeHead(503); return response.end("redis unavailable"); }
    return response.end("ok");
  }
  if (request.url === "/calls" && request.method === "POST") {
    if (request.headers.authorization !== `Bearer ${appGatewayKey}`) { response.writeHead(401); response.end("Unauthorized"); return; }
    const body = await readJsonBody(request);
    if (!body) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Некорректный JSON" })); return; }
    try {
      const result = await startOutboundCall(body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof CallAdmissionError ? error.httpStatus : 502;
      response.writeHead(status, {
        "content-type": "application/json",
        ...(status === 429 ? { "retry-after": "5" } : {}),
      });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (request.url === "/reload" && request.method === "POST") {
    if (request.headers.authorization !== `Bearer ${appGatewayKey}`) { response.writeHead(401); response.end("Unauthorized"); return; }
    try {
      const result = await amiAction({ Action: "Command", Command: "pjsip reload" });
      if (/Response:\s*Error|unable|failed|not found/i.test(result)) throw new Error("Asterisk rejected pjsip reload");
      response.end("ok");
    }
    catch (error) { response.writeHead(503); response.end(error.message); }
    return;
  }
  response.writeHead(404); response.end("Not found");
});

const browserServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
httpServer.on("upgrade", (request, socket, head) => {
  if (!redis.isReady) return socket.destroy();
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/session" && url.pathname !== "/voice-ws/session") return socket.destroy();
  if (browserServer.clients.size >= maxBrowserSessions) return socket.destroy();
  browserServer.handleUpgrade(request, socket, head, (ws) => browserServer.emit("connection", ws, request));
});

browserServer.on("connection", async (client, request) => {
  const url = new URL(request.url || "/", "http://localhost");
  const agentId = url.searchParams.get("agentId") || "";
  const tokenTenant = await validBrowserToken(url.searchParams.get("token"), agentId).catch((error) => {
    log("browser token validation failed", error.message);
    return null;
  });
  if (!tokenTenant) {
    client.close(1008, "Unauthorized");
    return;
  }
  const phone = `browser:${randomUUID()}`;
  const queued = [];
  let session;
  function forward(message) {
    if (message.type === "audio" && typeof message.audio === "string") return session.sendAudio(Buffer.from(message.audio, "base64"));
    if (message.type === "text" && typeof message.text === "string") {
      session.upstream.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", object: "realtime.item", role: "user", content: [{ type: "input_text", text: message.text }] } }));
      session.upstream.send(JSON.stringify({ type: "response.create" }));
    }
  }
  client.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (session?.upstream.readyState === WebSocket.OPEN) return forward(message);
    if (message.type === "text" && queued.length < 20) queued.push(message);
  });
  try {
    session = await createRealtimeSession({
      agentId,
      tenantId: tokenTenant,
      direction: "browser",
      phone,
      rate: 24000,
      onEvent: (event) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify({ type: "event", event })),
      onAudio: (audio) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify({ type: "audio", audio: audio.toString("base64") })),
      onClose: () => client.close(),
    });
    const flush = () => { while (queued.length && session.upstream.readyState === WebSocket.OPEN) forward(queued.shift()); };
    if (session.upstream.readyState === WebSocket.OPEN) flush();
    else session.upstream.on("open", flush);
    client.on("close", () => session.upstream.close());
  } catch (error) {
    client.send(JSON.stringify({ type: "error", error: error.message }));
    client.close();
  }
});

function uuidFromBytes(buffer) {
  const hex = buffer.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function audioFrame(audio) {
  const header = Buffer.alloc(3);
  header[0] = 0x10;
  header.writeUInt16BE(audio.length, 1);
  return Buffer.concat([header, audio]);
}

const audioSocketServer = net.createServer((socket) => {
  socket.on("error", (error) => log("ошибка сокета AudioSocket", error.message));
  const frameBytes = 320;
  const maximumQueuedAudioBytes = 8000 * 2 * 30;
  const maximumCallerBufferBytes = frameBytes * 250;
  let buffer = Buffer.alloc(0);
  let session;
  let callId = "";
  let meta;
  let durationTimer;
  let capacityRenewTimer;
  let capacityExpiryTimer;
  let capacityRenewInFlight = false;
  let capacityLeaseToken = "";
  let capacityLeaseValidUntil = 0;
  let capacityReleasePromise;
  let ticker;
  let outgoing = Buffer.alloc(0);
  let bed;
  let bedPosition = 0;
  let gain = 1;
  // Читается из колбэка, который может сработать раньше строки с настройками агента.
  let allowInterruptions = true;
  let recorder = null;
  let callerSinceTick = Buffer.alloc(0);
  let audioStartedAt = 0;
  let firstAudioReported = false;
  let handlingFrames = false;
  let callBecameLive = false;
  let terminalStatusPosted = false;

  async function postTerminalStatus(status, error = "") {
    if (terminalStatusPosted || !meta?.callId) return;
    await enqueueTerminalStatus(meta.callId, status, error, meta.tenantId || "");
    terminalStatusPosted = true;
    kickTerminalStatusOutbox();
  }

  function releaseCapacityLease() {
    clearInterval(capacityRenewTimer);
    clearTimeout(capacityExpiryTimer);
    if (!capacityLeaseToken || !callId) return Promise.resolve(false);
    if (!capacityReleasePromise) {
      capacityReleasePromise = releaseCallCapacity(callId, capacityLeaseToken)
        .catch((error) => {
          log("capacity lease release failed", `${callId} ${error.message}`);
          return false;
        });
    }
    return capacityReleasePromise;
  }

  function startCapacityLeaseRenewal() {
    const intervalMs = Math.max(5_000, Math.floor(capacityLeaseMs / 3));
    const armExpiryWatchdog = () => {
      capacityLeaseValidUntil = Date.now() + capacityLeaseMs;
      clearTimeout(capacityExpiryTimer);
      capacityExpiryTimer = setTimeout(() => {
        log("capacity lease renewal deadline reached", callId);
        socket.end();
      }, Math.max(1, capacityLeaseMs - 1_000));
      capacityExpiryTimer.unref?.();
    };
    armExpiryWatchdog();
    capacityRenewTimer = setInterval(() => {
      if (capacityRenewInFlight || !capacityLeaseToken || socket.destroyed) return;
      capacityRenewInFlight = true;
      renewCallCapacity(callId, capacityLeaseToken)
        .then((renewed) => {
          if (!renewed) {
            log("capacity lease ownership lost", callId);
            socket.end();
            return;
          }
          if (!capacityReleasePromise && !socket.destroyed) armExpiryWatchdog();
        })
        .catch((error) => {
          log("capacity lease renewal failed", `${callId} ${error.message}`);
          // Never keep a call alive beyond the point at which another gateway
          // may legitimately reclaim its expired slot.
          if (Date.now() + intervalMs >= capacityLeaseValidUntil) socket.end();
        })
        .finally(() => { capacityRenewInFlight = false; });
    }, intervalMs);
    capacityRenewTimer.unref?.();
  }

  // Asterisk принимает кадры в реальном времени: залповая запись переполняет
  // очередь канала и часть речи теряется. Поэтому отдаём строго по 20 мс.
  function writeAudio(audio) {
    if (!firstAudioReported && audio.length && audioStartedAt) {
      firstAudioReported = true;
      postCallMetric(meta?.callId, { firstAudioMs: Date.now() - audioStartedAt }, meta?.tenantId || "");
    }
    const gained = applyGain(audio, gain);
    const available = maximumQueuedAudioBytes - outgoing.length;
    if (available <= 0) return;
    outgoing = Buffer.concat([outgoing, gained.subarray(0, available)]);
  }

  function startOutput(ambientKind, ambientVolume) {
    audioStartedAt = Date.now();
    if (ambientKind && ambientKind !== "none") bed = ambientBed(ambientKind, 8000);
    ticker = setInterval(() => {
      if (!socket.writable) return;
      const silent = !outgoing.length;
      if (silent && !bed && !recorder) return;
      const frame = Buffer.alloc(frameBytes);
      if (!silent) {
        const take = Math.min(frameBytes, outgoing.length);
        outgoing.copy(frame, 0, 0, take);
        outgoing = outgoing.subarray(take);
      }
      const outFrame = bed ? mixAmbient(frame, bed, bedPosition, ambientVolume) : frame;
      if (!silent || bed) socket.write(audioFrame(outFrame));
      if (recorder) {
        const caller = callerSinceTick.subarray(0, frameBytes);
        callerSinceTick = callerSinceTick.subarray(caller.length);
        recorder.frame(caller, outFrame);
      }
      if (bed) bedPosition = (bedPosition + frameBytes) % bed.length;
    }, 20);
  }
  socket.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (handlingFrames) return;
    handlingFrames = true;
    try {
      while (buffer.length >= 3) {
        const type = buffer[0];
        const length = buffer.readUInt16BE(1);
        if (buffer.length < length + 3) return;
        const payload = buffer.subarray(3, length + 3);
        buffer = buffer.subarray(length + 3);
        if (type === 0x01 && payload.length === 16 && !session) {
          callId = uuidFromBytes(payload);
          try {
            if (startingCalls.has(callId) || liveCalls.has(callId)) throw new Error("Повторный AudioSocket для звонка");
            startingCalls.add(callId);
            meta = await takePendingCall(callId);
            if (!meta) throw new Error(`call metadata missing: ${callId}`);
            capacityLeaseToken = String(meta.capacityLeaseToken || "");
            if (!/^[0-9a-f-]{36}$/i.test(capacityLeaseToken)) throw new Error("У звонка нет доверенной резервации ёмкости");
            if (!await renewCallCapacity(callId, capacityLeaseToken)) throw new Error("Резервация ёмкости звонка истекла");
            startCapacityLeaseRenewal();
            await registerCallRecord(meta, meta.direction === "outbound" ? "outbound" : "inbound");
            session = await createRealtimeSession({
              agentId: meta.agentId,
              tenantId: meta.tenantId || "",
              connectionId: meta.connectionId || "",
              direction: meta.direction === "outbound" ? "outbound" : "inbound",
              phone: meta.phone,
              did: meta.did,
              rate: 8000,
              callMeta: meta,
              variables: meta.variables,
              onEvent: (event) => { if (event.type === "input_audio_buffer.speech_started" && allowInterruptions) outgoing = Buffer.alloc(0); },
              onAudio: writeAudio,
              onClose: () => socket.end(),
            });
            if (socket.destroyed) throw new Error("AudioSocket закрылся до запуска звонка");
            liveCalls.set(callId, session);
            const agent = session.runtime.agent;
            allowInterruptions = agent.allowInterruptions !== false;
            gain = Math.min(4, Math.max(1, Number(agent.outputGain) || 1));
            startOutput(agent.ambientSound, Math.min(1, Math.max(0, Number(agent.ambientVolume) || 0)));
            const limit = Number(meta.maxCallSeconds) || Number(agent.maxCallSeconds) || 0;
            if (limit > 0) durationTimer = setTimeout(() => { log("call duration limit reached", callId); socket.end(); }, limit * 1000);
            meta.tenantId = meta.tenantId || session.runtime.tenantId || "";
            await postCallStatus(meta.callId, "live", "", meta.tenantId);
            callBecameLive = true;
            // Запись включается только когда известен id карточки звонка:
            // файл ищется по нему, и у входящих он появляется лишь здесь.
            if (process.env.RECORDINGS_DIR) {
              await prepareRecordingArchive({
                directory: process.env.RECORDINGS_DIR,
                tenantId: meta.tenantId,
                callId: meta.callId,
              });
            }
            recorder = startRecording(process.env.RECORDINGS_DIR, meta.callId || "");
            if (recorder) log("recording started", recorder.path);
            else log("recording skipped", meta.callId ? "нет каталога записей" : "нет id звонка");
          } catch (error) {
            log("call setup failed", error.message);
            await postTerminalStatus("failed", error.message)
              .catch((problem) => log("terminal status enqueue failed", problem.message));
            socket.end();
          } finally {
            startingCalls.delete(callId);
          }
      } else if (type === 0x10 && session?.upstream.readyState === WebSocket.OPEN) {
        if (recorder) {
          callerSinceTick = Buffer.concat([callerSinceTick, payload]);
          if (callerSinceTick.length > maximumCallerBufferBytes) {
            callerSinceTick = callerSinceTick.subarray(callerSinceTick.length - maximumCallerBufferBytes);
          }
        }
          session.sendAudio(payload);
        } else if (type === 0x00) socket.end();
      }
    } finally {
      handlingFrames = false;
    }
  });
  socket.on("close", () => {
    clearTimeout(durationTimer);
    clearInterval(capacityRenewTimer);
    clearTimeout(capacityExpiryTimer);
    clearInterval(ticker);
    if (recorder) {
      const finishing = recorder;
      const archiveDetails = {
        filePath: finishing.path,
        tenantId: meta?.tenantId || "",
        callId: meta?.callId || "",
      };
      recorder = null;
      finishing.close()
        .then(async (seconds) => {
          if (!seconds || !archiveDetails.callId || !archiveDetails.tenantId) return;
          const job = { ...archiveDetails, recordedSeconds: seconds };
          const archived = await archiveRecordingFile(job);
          await acknowledgeRecording(job);
          if (archived.uploaded) await commitRecordingArchive(job);
        })
        .catch((problem) => log("recording archive failed", problem.message));
    }
    session?.upstream.close();
    if (meta?.callId) {
      void postTerminalStatus(
        callBecameLive ? "ended" : "failed",
        callBecameLive ? "" : "AudioSocket закрылся до запуска звонка",
      ).catch((problem) => log("terminal status enqueue failed", problem.message));
    }
    void releaseCapacityLease();
    deletePendingCall(callId).catch((problem) => log("pending call cleanup failed", problem.message));
    liveCalls.delete(callId);
  });
});

const recordingRetryWorker = startRecordingSpoolRetryWorker(process.env.RECORDINGS_DIR, {
  onArchiveReady: acknowledgeRecording,
  onResult: (result) => {
    if (result.uploaded || result.recovered || result.failed) {
      log("recording spool drain", JSON.stringify(result));
    }
  },
  onError: (error) => log("recording spool drain failed", error.message),
});
void recordingRetryWorker;

kickTerminalStatusOutbox();
const terminalOutboxTimer = setInterval(kickTerminalStatusOutbox, terminalOutboxIntervalMs);
terminalOutboxTimer.unref?.();

const fastAgiServer = net.createServer((socket) => {
  let input = "";
  let answered = false;
  socket.on("error", (error) => log("ошибка сокета FastAGI", error.message));
  socket.on("data", async (chunk) => {
    if (answered) return;
    input += chunk.toString();
    if (input.length > 65536) {
      answered = true;
      socket.destroy();
      return;
    }
    if (!input.includes("\n\n") && !input.includes("\r\n\r\n")) return;
    answered = true;
    const values = Object.fromEntries(input.split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : [line, ""];
    }));
    const script = values.agi_network_script || values.agi_request || "";
    const query = new URLSearchParams(script.includes("?") ? script.slice(script.indexOf("?") + 1) : "");
    const requested = query.get("uuid") || "";
    let id = "";
    let capacityLeaseToken = "";
    let reservationOwned = false;
    try {
      const pending = /^[0-9a-f-]{36}$/i.test(requested) ? await getPendingCall(requested) : null;
      if (pending) {
        id = requested;
        capacityLeaseToken = String(pending.capacityLeaseToken || "");
        if (!/^[0-9a-f-]{36}$/i.test(capacityLeaseToken)) throw new Error("У исходящего звонка нет резервации ёмкости");
        if (!await renewCallCapacity(id, capacityLeaseToken)) throw new Error("Резервация ёмкости исходящего звонка истекла");
        reservationOwned = true;
        pending.channel = values.agi_channel || "";
        await setPendingCall(id, pending);
      } else {
        id = randomUUID();
        const tenantId = query.get("tenantId") || "";
        const connectionId = query.get("connectionId") || "";
        const validTenant = tenantId === "default" || /^[0-9a-f-]{36}$/i.test(tenantId);
        if (!validTenant || !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) {
          throw new Error("missing trusted SIP endpoint identity");
        }
        capacityLeaseToken = randomUUID();
        await acquireCallCapacity(id, capacityLeaseToken);
        reservationOwned = true;
        await setPendingCall(id, {
          phone: values.agi_callerid || "unknown",
          did: values.agi_dnid && values.agi_dnid !== "unknown" ? values.agi_dnid : values.agi_extension || "",
          channel: values.agi_channel || "",
          tenantId,
          connectionId,
          capacityLeaseToken,
          direction: "inbound",
        });
      }
      if (!socket.writable) throw new Error("FastAGI connection closed before admission response");
      socket.write(`SET VARIABLE ASCN_CALL_UUID "${id}"\n`);
      reservationOwned = false;
    } catch (error) {
      log("FastAGI rejected call", error.message);
      if (reservationOwned) {
        await Promise.allSettled([
          deletePendingCall(id),
          releaseCallCapacity(id, capacityLeaseToken),
        ]);
      }
      if (socket.writable) socket.write("SET VARIABLE ASCN_CALL_UUID \"\"\n");
    }
    setTimeout(() => { if (!socket.destroyed) socket.end(); }, 200);
  });
});

httpServer.listen(port, "0.0.0.0", () => log(`browser gateway listening on ${port}`));
audioSocketServer.listen(9092, "0.0.0.0", () => log("Asterisk AudioSocket listening on 9092"));
fastAgiServer.listen(4573, "0.0.0.0", () => log("FastAGI listening on 4573"));
