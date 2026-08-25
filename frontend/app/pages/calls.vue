<script setup lang="ts">
import { PhoneCall, PhoneOutgoing, X } from "@lucide/vue";
import type { Agent, CallRecord, Contact, Message } from "~/types/voice";

const { notify } = useToast();
const contacts = ref<Contact[]>([]);
const calls = ref<CallRecord[]>([]);
const agents = ref<Pick<Agent, "id" | "name" | "active">[]>([]);
const selected = ref("");
const messages = ref<Message[]>([]);
const loading = ref(true);
const dialer = ref(false);
const calling = ref(false);
const filters = reactive({ id: "", minSeconds: "", from: "", to: "" });
const form = reactive({ agentId: "", toNumber: "", callerName: "", callerPurpose: "" });
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const statusLabels: Record<string, string> = { queued: "В очереди", dialing: "Набираем", live: "Идёт разговор", ended: "Завершён", failed: "Ошибка" };

function callSeconds(call: CallRecord) {
  if (!call.endedAt) return 0;
  const started = Date.parse(call.createdAt);
  const ended = Date.parse(call.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended > started ? Math.round((ended - started) / 1000) : 0;
}

function callDuration(call: CallRecord) {
  const total = callSeconds(call);
  return total ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : "—";
}

const activeId = computed(() => selected.value || contacts.value[0]?.id || "");
const contact = computed(() => contacts.value.find((item) => item.id === activeId.value));
const busy = computed(() => calls.value.some((call) => ["queued", "dialing", "live"].includes(call.status)));
const visibleCalls = computed(() => calls.value.filter((call) => {
  if (filters.id && !call.id.toLowerCase().includes(filters.id.trim().toLowerCase())) return false;
  if (filters.minSeconds && callSeconds(call) < Number(filters.minSeconds)) return false;
  if (filters.from && call.createdAt.slice(0, 10) < filters.from) return false;
  if (filters.to && call.createdAt.slice(0, 10) > filters.to) return false;
  return true;
}));

async function loadCalls() {
  const result = await apiFetch<{ calls: CallRecord[] }>("/api/voice/calls");
  calls.value = result.calls || [];
}

async function loadContacts() {
  const result = await apiFetch<{ contacts: Contact[] }>("/api/calls");
  contacts.value = result.contacts || [];
}

async function refresh() {
  try {
    await Promise.all([loadCalls(), loadContacts()]);
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось загрузить звонки");
  } finally {
    loading.value = false;
  }
}

async function loadMessages(id: string) {
  if (!id) { messages.value = []; return; }
  try {
    const result = await apiFetch<{ messages: Message[] }>(`/api/calls/${encodeURIComponent(id)}/messages`);
    messages.value = result.messages || [];
  } catch {
    messages.value = [];
  }
}

async function startCall() {
  calling.value = true;
  try {
    await apiFetch("/api/voice/calls", {
      method: "POST",
      body: {
        agentId: form.agentId || undefined,
        toNumber: form.toNumber,
        variables: { caller_name: form.callerName, caller_purpose: form.callerPurpose },
      },
    });
    notify("Звонок начат");
    dialer.value = false;
    form.toNumber = "";
    form.callerName = "";
    form.callerPurpose = "";
    await refresh();
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось начать звонок");
  } finally {
    calling.value = false;
  }
}

function resetFilters() {
  Object.assign(filters, { id: "", minSeconds: "", from: "", to: "" });
}

watch(activeId, loadMessages, { immediate: true });
watch(busy, (active) => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = active ? setInterval(refresh, 4000) : undefined;
}, { immediate: true });

onMounted(async () => {
  await refresh();
  try {
    const result = await apiFetch<{ agents: Agent[] }>("/api/voice/agents");
    agents.value = result.agents || [];
  } catch { /* Calls remain usable with the default agent. */ }
});
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<template>
  <div class="page-header">
    <div><h1>Звонки</h1><p>Входящие и исходящие звонки, расшифровки и итоги сохраняются автоматически.</p></div>
    <button class="primary-button" @click="dialer = !dialer"><X v-if="dialer" :size="16" /><PhoneOutgoing v-else :size="16" /> {{ dialer ? "Отмена" : "Позвонить" }}</button>
  </div>

  <section v-if="dialer" class="call-launcher">
    <div class="processing-grid">
      <label>Агент<select v-model="form.agentId"><option value="">Активный по умолчанию</option><option v-for="item in agents" :key="item.id" :value="item.id">{{ item.name }}{{ item.active ? "" : " (выключен)" }}</option></select></label>
      <label>Кому звоним<input v-model="form.toNumber" placeholder="+79001234567"></label>
      <label>Название или имя<input v-model="form.callerName" placeholder="Клиника на Ленина"></label>
      <label class="wide">Задача звонка<textarea v-model="form.callerPurpose" rows="3" placeholder="Перенести приём на пятницу после 17:00"></textarea></label>
    </div>
    <footer><small>Переменные <code v-pre>{{caller_name}}</code> и <code v-pre>{{caller_purpose}}</code> подставятся в промпт звонка.</small><button class="primary-button" :disabled="calling || !form.toNumber.trim()" @click="startCall">{{ calling ? "Набираем…" : "Начать звонок" }}</button></footer>
  </section>

  <section v-if="calls.length" class="call-filters">
    <label>ID звонка<input v-model="filters.id" placeholder="часть идентификатора"></label>
    <label>Дольше, сек<input :value="filters.minSeconds" placeholder="0" @input="filters.minSeconds = ($event.target as HTMLInputElement).value.replace(/[^0-9]/g, '')"></label>
    <label>С даты<input v-model="filters.from" type="date"></label>
    <label>По дату<input v-model="filters.to" type="date"></label>
    <small>{{ visibleCalls.length }} из {{ calls.length }}</small>
    <button v-if="filters.id || filters.minSeconds || filters.from || filters.to" class="ghost-button" @click="resetFilters">Сбросить</button>
  </section>

  <section v-if="visibleCalls.length" class="call-records">
    <article v-for="call in visibleCalls.slice(0, 30)" :key="call.id" :class="call.status">
      <header><span class="call-status" :class="call.status">{{ statusLabels[call.status] || call.status }}</span><strong>{{ call.phone }}</strong><small>{{ call.direction === "outbound" ? "исходящий" : "входящий" }}{{ call.agentName ? ` · ${call.agentName}` : "" }}</small><span class="call-meta">{{ callDuration(call) }}{{ call.toolCalls ? ` · ${call.toolCalls} инстр.` : "" }}</span><time>{{ new Date(call.createdAt).toLocaleString("ru-RU") }}</time></header>
      <p v-if="call.variables?.caller_purpose" class="call-purpose">{{ call.variables.caller_purpose }}</p>
      <audio v-if="call.recordedSeconds > 0" class="call-audio" controls preload="none" :src="`/api/voice/recordings/${call.id}`"></audio>
      <p v-if="call.error" class="call-error">{{ call.error }}</p>
      <div v-if="call.outcome" class="call-outcome"><strong>{{ call.outcome.resolved ? "Задача выполнена" : "Задача не закрыта" }}</strong><p v-if="call.outcome.summary">{{ call.outcome.summary }}</p><dl><template v-if="call.outcome.confirmation"><dt>Подтверждение</dt><dd>{{ call.outcome.confirmation }}</dd></template><template v-if="call.outcome.operator"><dt>Сотрудник</dt><dd>{{ call.outcome.operator }}</dd></template><template v-if="call.outcome.nextStep"><dt>Дальше</dt><dd>{{ call.outcome.nextStep }}</dd></template></dl></div>
    </article>
  </section>

  <div v-if="loading" class="voice-loading">Загружаем звонки…</div>
  <section v-else-if="!contacts.length" class="empty-state"><div class="add-circle"><PhoneCall :size="21" /></div><h2>Разговоров пока нет</h2><p>После первого звонка здесь появится контакт и полная расшифровка диалога.</p><button class="primary-button" @click="refresh">Обновить</button></section>
  <div v-else class="calls-layout">
    <section class="calls-list"><button v-for="item in contacts" :key="item.id" :class="{ selected: activeId === item.id }" @click="selected = item.id"><span class="call-avatar"><PhoneCall :size="16" /></span><div><strong>{{ item.name }}</strong><small>{{ item.phone }}</small><p>{{ item.lastMessage }}</p></div><time>{{ new Date(item.updatedAt).toLocaleString("ru-RU") }}</time></button></section>
    <section class="call-transcript"><header><div class="call-avatar large"><PhoneCall :size="18" /></div><div><h2>{{ contact?.name }}</h2><p>{{ contact?.phone }} · {{ contact?.language }}</p></div></header><div><article v-for="messageItem in messages" :key="messageItem.id" :class="messageItem.direction"><span>{{ messageItem.direction === "inbound" ? "Клиент" : "AI-агент" }}</span><p>{{ messageItem.text }}</p><time>{{ new Date(messageItem.createdAt).toLocaleString("ru-RU") }}</time></article></div></section>
  </div>
</template>
