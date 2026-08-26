<script setup lang="ts">
import { ArrowLeft, AudioLines, BookOpen, Bot, Code2, Plus, Save, ShieldAlert, Sparkles, Trash2, Upload, Wrench, X } from "@lucide/vue";
import type { Agent, CallRecord, PhoneConnection, Provider, Tool, VoiceSettings } from "~/types/voice";
import { builtins, models, newPhoneConnection, providerLabels, timezones, uid, voices } from "~/utils/voice";

const props = defineProps<{ agent: Agent; settings: VoiceSettings; saving: boolean }>();
const emit = defineEmits<{
  back: [];
  save: [agent: Agent];
  publish: [agent: Agent, live: boolean];
  "add-number": [connection: PhoneConnection];
}>();

const { notify } = useToast();
const draft = ref<Agent>(structuredClone(toRaw(props.agent)));
const tab = ref("config");
const improving = ref(false);
const previewing = ref(false);
const snippet = ref("curl");
const knowledgeInput = ref<HTMLInputElement | null>(null);
const avatarInput = ref<HTMLInputElement | null>(null);
const calls = ref<CallRecord[]>([]);
const metrics = ref<Record<string, number | null> | null>(null);
const tester = ref(false);

watch(() => props.agent, (next) => { draft.value = structuredClone(toRaw(next)); }, { deep: true });

const providerModels = computed(() => models.filter((model) => model.provider === draft.value.provider));
const availableTools = computed(() => builtins.filter(([name]) => !draft.value.tools.some((tool) => tool.type === "ascn" && tool.name === name)));
const connectedNumbers = computed(() => props.settings.phoneConnections.filter((item) => item.agentId === draft.value.id));

function changeProvider(provider: Provider) {
  draft.value.provider = provider;
  draft.value.model = models.find((item) => item.provider === provider)?.id || "";
  draft.value.voice = voices[provider][0] || "";
  draft.value.tools = draft.value.tools.filter((tool) => provider !== "openai" || !["web_search", "file_search"].includes(tool.type));
}

function addTool(type: "ascn" | "dtmf", name?: string) {
  if (draft.value.tools.length >= 8) return notify("Можно подключить не больше восьми инструментов");
  draft.value.tools.push({ id: uid(), type, ...(name ? { name } : {}) });
}

function toolLabel(tool: Tool) {
  if (tool.type === "dtmf") return "Тональный набор (IVR)";
  return builtins.find(([name]) => name === tool.name)?.[1] || tool.name || tool.type;
}

async function improvePrompt() {
  improving.value = true;
  try {
    const result = await apiFetch<{ instructions: string }>("/api/voice/improve-prompt", {
      method: "POST",
      body: { provider: draft.value.provider, instructions: draft.value.instructions, name: draft.value.name, description: draft.value.description },
    });
    draft.value.instructions = result.instructions;
    notify("Промпт улучшен — проверьте и сохраните");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Модель не ответила");
  } finally {
    improving.value = false;
  }
}

async function addKnowledge(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])].slice(0, Math.max(0, 20 - draft.value.knowledge.length));
  for (const file of files) {
    if (file.size > 300_000) { notify(`${file.name}: больше 300 КБ, пропущен`); continue; }
    draft.value.knowledge.push({ id: uid(), name: file.name, text: await file.text() });
  }
  input.value = "";
}

function addAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 200_000) return notify("Картинка больше 200 КБ");
  const reader = new FileReader();
  reader.onload = () => { draft.value.avatar = String(reader.result || ""); };
  reader.readAsDataURL(file);
}

async function playVoice() {
  previewing.value = true;
  try {
    const response = await fetch("/api/voice/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: draft.value.provider, model: draft.value.model, voice: draft.value.voice, phrase: draft.value.firstMessage || "Здравствуйте! Чем могу помочь?" }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Не удалось создать пример");
    const url = URL.createObjectURL(await response.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось воспроизвести голос");
  } finally {
    previewing.value = false;
  }
}

function addNumber() {
  emit("add-number", newPhoneConnection(props.settings.phoneConnections.length, draft.value.id));
  notify("Номер добавлен выключенным — заполните SIP-данные в разделе подключений");
}

function codeSnippet(kind: string) {
  const body = JSON.stringify({ agentId: draft.value.id || "AGENT_ID", toNumber: "+79001234567", variables: { caller_name: "Иван", caller_purpose: "Уточнить наличие" } });
  if (kind === "TypeScript") return `await fetch("https://ВАШ_ДОМЕН/api/voice/calls", {\n  method: "POST",\n  headers: { "content-type": "application/json", authorization: "Basic ..." },\n  body: JSON.stringify(${body})\n});`;
  if (kind === "Python") return `requests.post("https://ВАШ_ДОМЕН/api/voice/calls", auth=("admin", "ПАРОЛЬ"), json=${body})`;
  return `curl -u admin:ПАРОЛЬ -H "content-type: application/json" -d '${body}' https://ВАШ_ДОМЕН/api/voice/calls`;
}

async function loadAgentData() {
  if (!draft.value.id) return;
  try {
    const [callData, insightData] = await Promise.all([
      apiFetch<{ calls: CallRecord[] }>("/api/voice/calls"),
      apiFetch<Record<string, number | null>>(`/api/voice/insights?days=30&agentId=${encodeURIComponent(draft.value.id)}`),
    ]);
    calls.value = (callData.calls || []).filter((call) => call.agentId === draft.value.id);
    metrics.value = insightData;
  } catch { /* Editor remains available if statistics fail. */ }
}

onMounted(loadAgentData);
</script>

<template>
  <div class="voice-editor-page" :class="{ solo: !tester }"><div class="voice-editor-pane">
    <button type="button" class="text-button back-link" @click="emit('back')"><ArrowLeft :size="15" /> Назад</button>
    <header class="agent-hero">
      <div class="avatar-picker"><button type="button" class="agent-avatar" @click="avatarInput?.click()"><img v-if="draft.avatar?.startsWith('data:')" :src="draft.avatar" alt="" width="56" height="56"><b v-else-if="draft.avatar">{{ draft.avatar }}</b><Bot v-else :size="22" /></button><input ref="avatarInput" class="sr-only" type="file" accept="image/*" @change="addAvatar"></div>
      <div><h1>{{ draft.name.trim() || "Новый голосовой агент" }}</h1><div class="agent-hero-meta"><span>{{ draft.publishedAt ? `Опубликован ${new Date(draft.publishedAt).toLocaleString('ru-RU')}` : "Ещё не публиковался" }}</span><span class="live-badge" :class="draft.live ? (draft.unpublished ? 'changed' : '') : 'draft'"><i></i>{{ draft.live ? (draft.unpublished ? "Черновик изменён" : "В эфире") : "Черновик" }}</span></div></div>
      <div class="agent-hero-actions"><label class="voice-active"><span>Принимать звонки</span><span class="switch"><input v-model="draft.active" type="checkbox"><span></span></span></label><button class="pill-button" :disabled="!draft.id" @click="tester = !tester">{{ tester ? "Закрыть тест" : "Тестировать" }}</button><button v-if="draft.live" class="pill-button" @click="emit('publish', draft, false)">Снять</button><button class="pill-button solid" :disabled="!draft.id" @click="emit('publish', draft, true)">Опубликовать</button></div>
    </header>

    <div class="agent-tabs"><button v-for="item in [{id:'config',label:'Настройки'},{id:'speech',label:'Речь'},{id:'deploy',label:'Публикация'},{id:'calls',label:'Разговоры'},{id:'insights',label:'Показатели'}]" :key="item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button></div>
    <div class="voice-form-scroll">
      <template v-if="tab === 'config'">
        <div class="setup-banner"><Bot :size="16" /><strong>{{ connectedNumbers.length ? "Номер подключён" : "Подключите номер" }}</strong><span>{{ connectedNumbers.length ? connectedNumbers.map((item) => item.number || item.name).join(', ') : "чтобы на агента можно было позвонить" }}</span><button class="pill-button solid" @click="addNumber">{{ connectedNumbers.length ? "Ещё номер" : "Настроить" }}</button></div>
        <label class="voice-field"><span>Имя</span><input v-model="draft.name" maxlength="80"></label>
        <label class="voice-field"><span>Описание <i>необязательно</i></span><input v-model="draft.description" placeholder="Для чего нужен этот агент"></label>
        <div class="agent-model-grid"><label class="voice-field"><span>AI-провайдер</span><select :value="draft.provider" @change="changeProvider(($event.target as HTMLSelectElement).value as Provider)"><option v-for="(label, value) in providerLabels" :key="value" :value="value">{{ label }}</option></select></label><label class="voice-field"><span>Realtime-модель</span><select v-model="draft.model"><option v-for="model in providerModels" :key="model.id" :value="model.id">{{ model.label }}</option></select><small>{{ models.find((item) => item.id === draft.model)?.note }}</small></label></div>
        <section class="prompt-section"><div class="voice-section-title"><span>Системный промпт*</span><button class="text-button" :disabled="improving || !draft.instructions.trim()" @click="improvePrompt"><Sparkles :size="14" /> {{ improving ? "Переписываю…" : "Улучшить моделью" }}</button></div><textarea v-model="draft.instructions" class="soft-textarea" rows="10"></textarea></section>
        <section class="variables-section"><div class="voice-section-title"><span>Переменные</span><button @click="draft.variables.push({ id: uid(), key: '', value: '' })"><Plus :size="14" /> Добавить переменную</button></div><div v-for="variable in draft.variables" :key="variable.id" class="variable-row"><input v-model="variable.key" placeholder="service_name"><input v-model="variable.value" placeholder="Значение"><button aria-label="Удалить" @click="draft.variables = draft.variables.filter((item) => item.id !== variable.id)"><X :size="15" /></button></div></section>
        <section class="prompt-section guardrails"><div class="voice-section-title"><span><ShieldAlert :size="16" /> Запреты</span></div><textarea v-model="draft.guardrails" rows="4" placeholder="Не обещать скидки и сроки без подтверждения"></textarea></section>
        <section class="prompt-section knowledge"><div class="voice-section-title"><span><BookOpen :size="16" /> База знаний <i>{{ draft.knowledge.length }}/20</i></span><button class="improve-button" @click="knowledgeInput?.click()"><Upload :size="14" /> Загрузить файлы</button></div><input ref="knowledgeInput" class="sr-only" type="file" multiple accept=".txt,.md,.csv,.json,.yaml,.yml,text/plain" @change="addKnowledge"><ul v-if="draft.knowledge.length" class="knowledge-list"><li v-for="file in draft.knowledge" :key="file.id"><strong>{{ file.name }}</strong><small>{{ file.text.length }} знаков</small><button class="icon-button" @click="draft.knowledge = draft.knowledge.filter((item) => item.id !== file.id)"><Trash2 :size="15" /></button></li></ul><p v-else class="knowledge-empty">Текстовые файлы с каталогом, правилами или ответами на вопросы.</p></section>
        <section class="setting-block"><div class="setting-row"><div><strong>Агент говорит первым</strong><p>Открывает разговор заданной фразой.</p></div><label class="switch"><input v-model="draft.speaksFirst" type="checkbox"><span></span></label></div><textarea v-if="draft.speaksFirst" v-model="draft.firstMessage" class="soft-textarea" rows="2" placeholder="Здравствуйте! Чем могу помочь?"></textarea><div class="setting-row filled"><div><strong>Собеседник может перебивать</strong></div><label class="switch"><input v-model="draft.allowInterruptions" type="checkbox"><span></span></label></div><div class="setting-row"><div><strong>Агент знает номер звонящего</strong></div><label class="switch"><input v-model="draft.shareCallerNumber" type="checkbox"><span></span></label></div></section>
        <section class="tools-section"><div class="voice-section-title"><span><Wrench :size="16" /> Инструменты <i>{{ draft.tools.length }}/8</i></span></div><div class="tool-list"><article v-for="tool in draft.tools" :key="tool.id" class="tool-row"><header><span><Wrench :size="15" /> {{ toolLabel(tool) }}</span><button @click="draft.tools = draft.tools.filter((item) => item.id !== tool.id)"><Trash2 :size="15" /></button></header></article></div><div class="tool-catalog"><div v-for="entry in availableTools" :key="entry[0]" class="tool-offer"><i><Wrench :size="16" /></i><div><strong>{{ entry[1] }}</strong></div><button class="pill-button" @click="addTool('ascn', entry[0])">Добавить</button></div><div v-if="!draft.tools.some((tool) => tool.type === 'dtmf')" class="tool-offer"><i><Wrench :size="16" /></i><div><strong>Тональный набор (IVR)</strong></div><button class="pill-button" @click="addTool('dtmf')">Добавить</button></div></div></section>
      </template>

      <section v-else-if="tab === 'speech'" class="setting-block">
        <div class="setting-row"><div><strong>Голос</strong><p>Голос выбранного realtime-провайдера.</p></div><div class="row-control"><select v-model="draft.voice"><option v-for="voice in voices[draft.provider]" :key="voice" :value="voice">{{ voice }}</option></select><button class="text-button" :disabled="previewing" @click="playVoice"><AudioLines :size="14" /> {{ previewing ? "Генерирую…" : "Прослушать" }}</button></div></div>
        <div class="setting-row"><div><strong>Язык</strong></div><select v-model="draft.recognitionLanguage"><option value="auto">Автоопределение</option><option value="ru-RU">Русский</option><option value="en-US">Английский</option><option value="kk-KZ">Казахский</option></select></div>
        <div class="setting-row"><div><strong>Скорость речи</strong></div><select v-model.number="draft.speed"><option v-for="speed in [0.8,0.9,1,1.1,1.2,1.3,1.5]" :key="speed" :value="speed">{{ speed }}×</option></select></div>
        <div class="setting-row"><div><strong>Часовой пояс</strong></div><select v-model="draft.timezone"><option v-for="zone in timezones" :key="zone" :value="zone">{{ zone }}</option></select></div>
        <div class="setting-row"><div><strong>Ключевые слова</strong></div></div><textarea v-model="draft.keyterms" class="soft-textarea" rows="2" placeholder="New Balance, СДЭК, 43 размер"></textarea>
        <details class="speech-advanced"><summary>Тонкая настройка</summary><div class="processing-grid"><label>Чувствительность<input v-model.number="draft.vadThreshold" type="number" min="0" max="1" step="0.1"></label><label>Тишина, мс<input v-model.number="draft.silenceDurationMs" type="number" min="100" max="5000" step="100"></label><label>Громкость<input v-model.number="draft.outputGain" type="number" min="1" max="4" step="0.1"></label><label>Лимит звонка, сек<input v-model.number="draft.maxCallSeconds" type="number" min="0" max="7200" step="30"></label></div></details>
      </section>

      <section v-else-if="tab === 'deploy'" class="prompt-section integration"><div class="voice-section-title"><span><Code2 :size="16" /> Подключение</span></div><label class="voice-field"><span>Письмо после звонка</span><input v-model="draft.notifyEmail" placeholder="boss@example.com"><small>{{ settings.smtpHost ? `Отправляем через ${settings.smtpHost}` : "Сначала настройте SMTP в подключениях" }}</small></label><div class="snippet-tabs"><button v-for="kind in ['curl','TypeScript','Python']" :key="kind" :class="{ active: snippet === kind }" @click="snippet = kind">{{ kind }}</button></div><pre class="snippet-code">{{ codeSnippet(snippet) }}</pre></section>

      <section v-else-if="tab === 'calls'" class="call-records"><p v-if="!draft.id" class="knowledge-empty">Сначала сохраните агента.</p><p v-else-if="!calls.length" class="knowledge-empty">Этот агент ещё не разговаривал.</p><article v-for="call in calls.slice(0,30)" :key="call.id" :class="call.status"><header><span class="call-status" :class="call.status">{{ call.status }}</span><strong>{{ call.phone }}</strong><small>{{ call.direction === 'outbound' ? 'исходящий' : 'входящий' }}</small><time>{{ new Date(call.createdAt).toLocaleString('ru-RU') }}</time></header><audio v-if="call.recordedSeconds > 0" class="call-audio" controls preload="none" :src="`/api/voice/recordings/${call.id}`"></audio></article></section>

      <section v-else class="insights-grid"><article><small>Разговоров, 30 дней</small><strong>{{ metrics?.conversations ?? 0 }}</strong></article><article><small>Минут</small><strong>{{ metrics?.totalMinutes ?? 0 }}</strong></article><article><small>Вызовов инструментов</small><strong>{{ metrics?.toolCalls ?? 0 }}</strong></article><article><small>Доля ошибок</small><strong>{{ metrics?.errorRate ?? "—" }}{{ metrics?.errorRate == null ? "" : "%" }}</strong></article></section>
    </div>
    <footer class="voice-editor-actions"><button class="ghost-button" @click="emit('back')">Отмена</button><button class="primary-button" :disabled="saving" @click="emit('save', draft)"><Save :size="15" /> {{ saving ? "Сохраняем…" : draft.id ? "Сохранить" : "Создать" }}</button></footer>
  </div><VoiceTester v-if="tester" :agent="draft" :settings="settings" /></div>
</template>
