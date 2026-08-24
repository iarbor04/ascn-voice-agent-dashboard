import http from "node:http";
import net from "node:net";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { applyGain, resamplePcm16 } from "./audio.mjs";
import { startRecording } from "./recorder.mjs";

const port = Number(process.env.PORT || 8787);
const appUrl = (process.env.ASCN_APP_URL || "http://app:3000").replace(/\/$/, "");
const internalKey = process.env.INTERNAL_API_KEY || "";
const pendingCalls = new Map();
const liveCalls = new Map();

// Токен: agentId.tenantId.expiresAt.signature — тенант возвращаем строкой.
function validBrowserToken(token, agentId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== agentId || !internalKey) return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  const expected = createHmac("sha256", internalKey).update(`${parts[0]}.${parts[1]}.${parts[2]}`).digest("base64url");
  const actualBuffer = Buffer.from(parts[3]);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer) ? parts[1] : null;
}

function log(message, details = "") {
  console.log(`[voice-gateway] ${message}${details ? ` ${details}` : ""}`);
}

async function appRequest(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${internalKey}`, "content-type": "application/json", ...(options.headers || {}) },
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
  if (tool.type === "mcp") return { type: "mcp", server_label: tool.label, server_url: tool.url, authorization: tool.authorization, require_approval: tool.requireApproval };
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

async function postTranscript(phone, direction, text, tenantId = "") {
  if (!text?.trim()) return;
  await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "transcript", phone, direction, text, tenantId }) }).catch((error) => log("transcript save failed", error.message));
}

function postCallMetric(callId, metric, tenantId = "") {
  if (!callId) return;
  appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "call_metric", callId, tenantId, ...metric }) }).catch((problem) => log("call metric failed", problem.message));
}

async function postCallStatus(callId, status, error = "", tenantId = "") {
  if (!callId) return;
  await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "call_status", callId, status, error, tenantId }) }).catch((problem) => log("call status failed", problem.message));
}

async function registerCallRecord(meta, direction) {
  if (meta.callId) return meta.callId;
  const body = await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "call_started", direction, phone: meta.phone, agentId: meta.agentId || "", tenantId: meta.tenantId || "", did: meta.did || "" }) }).catch((problem) => { log("call record failed", problem.message); return null; });
  meta.callId = body?.call?.id || "";
  return meta.callId;
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
  const password = process.env.ASTERISK_AMI_PASSWORD || "ascn-internal";
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: process.env.ASTERISK_HOST || "asterisk", port: 5038 });
    let output = "";
    socket.setTimeout(3000);
    socket.on("connect", () => {
      const actions = [
        { Action: "Login", Username: "ascn", Secret: password, Events: "off" },
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
    const response = await fetch(custom.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(custom.authorization ? { authorization: custom.authorization } : {}) },
      body: JSON.stringify({ arguments: args, caller: phone }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
    try { return JSON.parse(text); } catch { return { result: text.slice(0, 10000) }; }
  }
  return appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "tool", tenantId: runtime.tenantId || "", phone, name: toolName, arguments: args, agentId: runtime.agent.id }) });
}

async function createRealtimeSession({ agentId, tenantId, phone, did, rate, callMeta, variables, onEvent, onAudio, onClose }) {
  const runtime = await appRequest("/api/voice/runtime", { method: "POST", body: JSON.stringify({ action: "session", phone, did: did || "", agentId: agentId || "", tenantId: tenantId || "", variables: variables || {} }) });
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
        await postTranscript(phone, "inbound", event.transcript || "", runtime.tenantId || "");
      } else log("повторная расшифровка отброшена", transcriptKey);
    }
    if (event.type === "response.created") activeResponseId = event.response?.id || "";
    if (event.type === "input_audio_buffer.speech_started") clearTimeout(followUpTimer);
    if (event.type === "input_audio_buffer.speech_started" && runtime.agent.allowInterruptions !== false && activeResponseId && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "response.cancel", response_id: activeResponseId }));
    }
    if (event.type === "response.output_text.delta" || event.type === "response.output_audio_transcript.delta" || event.type === "response.text.delta" || event.type === "response.audio_transcript.delta") assistantText += event.delta || "";
    if (event.type === "response.done" && assistantText) {
      await postTranscript(phone, "outbound", assistantText, runtime.tenantId || "");
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
  if (!/^[0-9a-f-]{36}$/i.test(callId) || !toNumber || !endpoint) throw new Error("Некорректные параметры звонка");
  pendingCalls.set(callId, {
    phone: toNumber,
    did: "",
    channel: "",
    callId,
    agentId: String(body.agentId || ""),
    tenantId: String(body.tenantId || ""),
    variables: body.variables && typeof body.variables === "object" ? body.variables : {},
    maxCallSeconds: Number(body.maxCallSeconds) || 0,
    direction: "outbound",
  });
  try {
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
    pendingCalls.delete(callId);
    throw error;
  }
}

const httpServer = http.createServer(async (request, response) => {
  if (request.url === "/health") return response.end("ok");
  if (request.url === "/calls" && request.method === "POST") {
    if (request.headers.authorization !== `Bearer ${internalKey}`) { response.writeHead(401); response.end("Unauthorized"); return; }
    const body = await readJsonBody(request);
    if (!body) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Некорректный JSON" })); return; }
    try {
      const result = await startOutboundCall(body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (request.url === "/reload" && request.method === "POST") {
    if (request.headers.authorization !== `Bearer ${internalKey}`) { response.writeHead(401); response.end("Unauthorized"); return; }
    try { await amiAction({ Action: "Command", Command: "pjsip reload" }); response.end("ok"); }
    catch (error) { response.writeHead(503); response.end(error.message); }
    return;
  }
  response.writeHead(404); response.end("Not found");
});

const browserServer = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/session" && url.pathname !== "/voice-ws/session") return socket.destroy();
  browserServer.handleUpgrade(request, socket, head, (ws) => browserServer.emit("connection", ws, request));
});

browserServer.on("connection", async (client, request) => {
  const url = new URL(request.url || "/", "http://localhost");
  const agentId = url.searchParams.get("agentId") || "";
  const tokenTenant = validBrowserToken(url.searchParams.get("token"), agentId);
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
  let buffer = Buffer.alloc(0);
  let session;
  let callId = "";
  let meta;
  let durationTimer;
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

  // Asterisk принимает кадры в реальном времени: залповая запись переполняет
  // очередь канала и часть речи теряется. Поэтому отдаём строго по 20 мс.
  function writeAudio(audio) {
    if (!firstAudioReported && audio.length && audioStartedAt) {
      firstAudioReported = true;
      postCallMetric(meta?.callId, { firstAudioMs: Date.now() - audioStartedAt }, meta?.tenantId || "");
    }
    outgoing = Buffer.concat([outgoing, applyGain(audio, gain)]);
  }

  function startOutput(ambientKind, ambientVolume) {
    audioStartedAt = Date.now();
    if (ambientKind && ambientKind !== "none") bed = ambientBed(ambientKind, 8000);
    ticker = setInterval(() => {
      if (!socket.writable) return;
      const silent = !outgoing.length;
      if (silent && !bed) return;
      const frame = Buffer.alloc(frameBytes);
      if (!silent) {
        const take = Math.min(frameBytes, outgoing.length);
        outgoing.copy(frame, 0, 0, take);
        outgoing = outgoing.subarray(take);
      }
      const outFrame = bed ? mixAmbient(frame, bed, bedPosition, ambientVolume) : frame;
      socket.write(audioFrame(outFrame));
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
    while (buffer.length >= 3) {
      const type = buffer[0];
      const length = buffer.readUInt16BE(1);
      if (buffer.length < length + 3) return;
      const payload = buffer.subarray(3, length + 3);
      buffer = buffer.subarray(length + 3);
      if (type === 0x01 && payload.length === 16 && !session) {
        callId = uuidFromBytes(payload);
        meta = pendingCalls.get(callId) || { phone: "unknown", channel: "", direction: "inbound" };
        try {
          session = await createRealtimeSession({
            agentId: meta.agentId,
            tenantId: meta.tenantId || "",
            phone: meta.phone,
            did: meta.did,
            rate: 8000,
            callMeta: meta,
            variables: meta.variables,
            onEvent: (event) => { if (event.type === "input_audio_buffer.speech_started" && allowInterruptions) outgoing = Buffer.alloc(0); },
            onAudio: writeAudio,
            onClose: () => socket.end(),
          });
          liveCalls.set(callId, session);
          const agent = session.runtime.agent;
          allowInterruptions = agent.allowInterruptions !== false;
          gain = Math.min(4, Math.max(1, Number(agent.outputGain) || 1));
          startOutput(agent.ambientSound, Math.min(1, Math.max(0, Number(agent.ambientVolume) || 0)));
          const limit = Number(meta.maxCallSeconds) || Number(agent.maxCallSeconds) || 0;
          if (limit > 0) durationTimer = setTimeout(() => { log("call duration limit reached", callId); socket.end(); }, limit * 1000);
          meta.tenantId = meta.tenantId || session.runtime.tenantId || "";
          if (meta.callId) await postCallStatus(meta.callId, "live", "", meta.tenantId);
          else await registerCallRecord(meta, meta.direction === "outbound" ? "outbound" : "inbound");
          // Запись включается только когда известен id карточки звонка:
          // файл ищется по нему, и у входящих он появляется лишь здесь.
          recorder = startRecording(process.env.RECORDINGS_DIR, meta.callId || "");
          if (recorder) log("recording started", recorder.path);
          else log("recording skipped", meta.callId ? "нет каталога записей" : "нет id звонка");
        } catch (error) {
          log("call setup failed", error.message);
          if (meta.callId) await postCallStatus(meta.callId, "failed", error.message, meta?.tenantId || "");
          socket.end();
        }
      } else if (type === 0x10 && session?.upstream.readyState === WebSocket.OPEN) {
        if (recorder) callerSinceTick = Buffer.concat([callerSinceTick, payload]);
        session.sendAudio(payload);
      } else if (type === 0x00) socket.end();
    }
  });
  socket.on("close", () => {
    clearTimeout(durationTimer);
    clearInterval(ticker);
    if (recorder) {
      const finishing = recorder;
      recorder = null;
      finishing.close()
        .then((seconds) => { if (seconds && meta?.callId) postCallMetric(meta.callId, { recordedSeconds: seconds }, meta?.tenantId || ""); })
        .catch((problem) => log("recording close failed", problem.message));
    }
    session?.upstream.close();
    if (meta?.callId) postCallStatus(meta.callId, "ended", "", meta?.tenantId || "");
    pendingCalls.delete(callId);
    liveCalls.delete(callId);
  });
});

const fastAgiServer = net.createServer((socket) => {
  let input = "";
  let answered = false;
  socket.on("error", (error) => log("ошибка сокета FastAGI", error.message));
  socket.on("data", (chunk) => {
    if (answered) return;
    input += chunk.toString();
    if (!input.includes("\n\n") && !input.includes("\r\n\r\n")) return;
    const values = Object.fromEntries(input.split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : [line, ""];
    }));
    const requested = /uuid=([0-9a-f-]{36})/i.exec(values.agi_network_script || values.agi_request || "")?.[1] || "";
    const pending = requested ? pendingCalls.get(requested) : undefined;
    const id = pending ? requested : randomUUID();
    if (pending) pending.channel = values.agi_channel || "";
    else pendingCalls.set(id, {
      phone: values.agi_callerid || "unknown",
      did: values.agi_dnid || values.agi_extension || "",
      channel: values.agi_channel || "",
      direction: "inbound",
    });
    answered = true;
    if (socket.writable) socket.write(`SET VARIABLE ASCN_CALL_UUID "${id}"\n`);
    setTimeout(() => { if (!socket.destroyed) socket.end(); }, 200);
  });
});

httpServer.listen(port, "0.0.0.0", () => log(`browser gateway listening on ${port}`));
audioSocketServer.listen(9092, "0.0.0.0", () => log("Asterisk AudioSocket listening on 9092"));
fastAgiServer.listen(4573, "0.0.0.0", () => log("FastAGI listening on 4573"));
