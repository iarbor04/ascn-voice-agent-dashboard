<script setup lang="ts">
import { CircleStop, Mic } from "@lucide/vue";
import type { Agent, VoiceSettings } from "~/types/voice";

const props = defineProps<{ agent: Agent; settings: VoiceSettings }>();
const { notify } = useToast();
const status = ref<"idle" | "connecting" | "live">("idle");
const messages = ref<Array<{ role: "user" | "agent"; text: string }>>([]);
const textInput = ref("");
let socket: WebSocket | null = null;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let sources: AudioBufferSourceNode[] = [];
let nextPlay = 0;
let agentText = "";

function base64FromBytes(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function bytesFromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function clearPlayback() {
  for (const item of sources) { try { item.stop(); } catch { /* Already stopped. */ } }
  sources = [];
  nextPlay = context?.currentTime || 0;
}

function playPcm(base64: string) {
  if (!context) return;
  const bytes = bytesFromBase64(base64);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  const buffer = context.createBuffer(1, samples.length, 24_000);
  buffer.copyToChannel(samples, 0);
  const output = context.createBufferSource();
  output.buffer = buffer;
  output.connect(context.destination);
  const startAt = Math.max(context.currentTime + 0.02, nextPlay);
  output.start(startAt);
  nextPlay = startAt + buffer.duration;
  sources.push(output);
  output.onended = () => { sources = sources.filter((item) => item !== output); };
}

function stop() {
  processor?.disconnect();
  sourceNode?.disconnect();
  socket?.close();
  stream?.getTracks().forEach((track) => track.stop());
  clearPlayback();
  void context?.close();
  socket = null; stream = null; context = null; processor = null; sourceNode = null;
  status.value = "idle";
}

async function start() {
  if (!props.agent.id) return notify("Сначала сохраните голосового агента");
  if (props.agent.provider === "yandex" && (!props.settings.yandexApiKeyConfigured || !props.settings.yandexFolderId)) return notify("Сначала подключите Yandex AI Studio");
  if (props.agent.provider === "openai" && !props.settings.openaiApiKeyConfigured) return notify("Сначала подключите OpenAI Realtime");
  if (props.agent.provider === "xai" && !props.settings.xaiApiKeyConfigured) return notify("Сначала подключите xAI");
  if (!props.settings.gatewayPublicUrl) return notify("Укажите публичный адрес voice gateway в подключении");
  status.value = "connecting";
  try {
    const tokenResult = await apiFetch<{ token: string }>("/api/voice/test-token", { method: "POST", body: { agentId: props.agent.id } });
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    context = new AudioContext({ sampleRate: 24_000 });
    nextPlay = context.currentTime;
    const socketUrl = new URL(props.settings.gatewayPublicUrl);
    socketUrl.searchParams.set("agentId", props.agent.id);
    socketUrl.searchParams.set("token", tokenResult.token);
    socket = new WebSocket(socketUrl);
    socket.onopen = () => {
      if (!context || !stream || !socket) return;
      sourceNode = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let index = 0; index < input.length; index += 1) pcm[index] = Math.max(-32768, Math.min(32767, (input[index] ?? 0) * 32768));
        socket.send(JSON.stringify({ type: "audio", audio: base64FromBytes(new Uint8Array(pcm.buffer)) }));
      };
      sourceNode.connect(processor);
      processor.connect(context.destination);
      status.value = "live";
    };
    socket.onmessage = (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.type === "audio") playPcm(payload.audio);
      const event = payload.event;
      if (event?.type === "input_audio_buffer.speech_started") clearPlayback();
      if (event?.type === "conversation.item.input_audio_transcription.completed" && event.transcript) messages.value.push({ role: "user", text: event.transcript });
      if (event?.type === "response.output_text.delta" || event?.type === "response.output_audio_transcript.delta") agentText += event.delta || "";
      if (event?.type === "response.done" && agentText) { messages.value.push({ role: "agent", text: agentText }); agentText = ""; }
      if (event?.type === "error") notify(event.error?.message || "Ошибка Realtime API");
      if (payload.type === "error") notify(payload.error || "Не удалось открыть сессию");
    };
    socket.onclose = () => { if (status.value !== "idle") stop(); };
  } catch (failure) {
    stop();
    notify(failure instanceof Error ? failure.message : "Нет доступа к микрофону");
  }
}

function sendText() {
  const text = textInput.value.trim();
  if (!text || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "text", text }));
  messages.value.push({ role: "user", text });
  textInput.value = "";
}

onBeforeUnmount(stop);
</script>

<template>
  <aside class="voice-tester"><header><div><span class="live-dot" :class="status"></span><div><h2>Тестирование голосового агента</h2><p>{{ status === "live" ? "Сессия активна — говорите естественно" : "Сохраните агента и запустите сессию" }}</p></div></div><span>24 kHz PCM</span></header><div class="test-dialog"><div v-if="!messages.length" class="test-empty"><div><Mic /></div><h3>{{ status === "live" ? "Я вас слушаю" : "Проверьте агента до подключения номера" }}</h3><p>Можно говорить, перебивать агента или отправить текст.</p></div><div v-for="(message, index) in messages" v-else :key="`${message.role}-${index}`" class="test-message" :class="message.role"><span>{{ message.role === "user" ? "Вы" : agent.name }}</span><p>{{ message.text }}</p></div></div><footer><label class="tester-speaks-first"><input type="checkbox" :checked="agent.speaksFirst" disabled> Агент говорит первым</label><div class="test-input"><input v-model="textInput" :disabled="status !== 'live'" placeholder="Напишите или используйте микрофон" @keydown.enter.prevent="sendText"><button :disabled="status !== 'live' || !textInput.trim()" @click="sendText">Отправить</button></div><button v-if="status === 'live'" class="stop-session" @click="stop"><CircleStop :size="17" /> Завершить сессию</button><button v-else class="start-session" :disabled="status === 'connecting' || !agent.id" @click="start"><Mic :size="17" /> {{ status === "connecting" ? "Подключаем…" : "Запустить сессию" }}</button></footer></aside>
</template>
