<script setup lang="ts">
import { FileDown, FileUp, ListRestart, Pause, PhoneCall, PhoneOutgoing, Play, Trash2, Users, X } from "@lucide/vue";
import type { Agent, CallCampaign, CallRecord, Contact, Message, PhoneConnection, VoiceSettings } from "~/types/voice";

const { notify } = useToast();
const contacts = ref<Contact[]>([]);
const calls = ref<CallRecord[]>([]);
const agents = ref<Pick<Agent, "id" | "name" | "active">[]>([]);
const connections = ref<PhoneConnection[]>([]);
const campaigns = ref<CallCampaign[]>([]);
const campaignDetails = ref<CallCampaign | null>(null);
const selected = ref("");
const messages = ref<Message[]>([]);
const loading = ref(true);
const dialer = ref(false);
const campaignCreator = ref(false);
const calling = ref(false);
const campaignSaving = ref(false);
const campaignFile = ref<File | null>(null);
const campaignFileInput = ref<HTMLInputElement | null>(null);
const filters = reactive({ id: "", minSeconds: "", from: "", to: "" });
const form = reactive({ agentId: "", toNumber: "", callerName: "", callerPurpose: "" });
const campaignForm = reactive({ name: "", agentId: "", connectionId: "", purposeTemplate: "", interval: 5, unit: "minutes" as "minutes" | "hours" });
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
const campaignBusy = computed(() => campaigns.value.some((campaign) => campaign.status === "running"));
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

async function loadCampaigns() {
  const result = await apiFetch<{ campaigns: CallCampaign[] }>("/api/voice/campaigns");
  campaigns.value = result.campaigns || [];
  if (campaignDetails.value) {
    const current = campaigns.value.find((item) => item.id === campaignDetails.value?.id);
    if (!current) campaignDetails.value = null;
    else {
      const details = await apiFetch<{ campaign: CallCampaign }>(`/api/voice/campaigns/${encodeURIComponent(current.id)}`);
      campaignDetails.value = details.campaign;
    }
  }
}

async function refresh() {
  try {
    await Promise.all([loadCalls(), loadContacts(), loadCampaigns()]);
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось загрузить звонки");
  } finally {
    loading.value = false;
  }
}

function toggleDialer() {
  dialer.value = !dialer.value;
  if (dialer.value) campaignCreator.value = false;
}

function toggleCampaignCreator() {
  campaignCreator.value = !campaignCreator.value;
  if (campaignCreator.value) dialer.value = false;
}

type CampaignPreview = {
  total: number;
  invalid: number;
  duplicates: number;
  extraKeys: string[];
  shown: number;
  rows: Array<{ phone: string; name: string; purpose: string; extra: Record<string, string> }>;
};

const campaignPreview = ref<CampaignPreview | null>(null);
const campaignPreviewError = ref("");
const campaignPreviewLoading = ref(false);

// Превью считает сервер тем же парсером, что и создание кампании,
// поэтому таблица показывает ровно то, что попадёт в обзвон.
async function loadCampaignPreview() {
  campaignPreview.value = null;
  campaignPreviewError.value = "";
  if (!campaignFile.value) return;
  campaignPreviewLoading.value = true;
  try {
    const body = new FormData();
    body.set("file", campaignFile.value);
    body.set("purposeTemplate", campaignForm.purposeTemplate);
    campaignPreview.value = await apiFetch<CampaignPreview>("/api/voice/campaigns/preview", { method: "POST", body });
  } catch (failure) {
    campaignPreviewError.value = failure instanceof Error ? failure.message : "Не удалось разобрать CSV";
  } finally {
    campaignPreviewLoading.value = false;
  }
}

// Общая задача подставляется в пустые purpose, поэтому после её правки
// таблица должна пересчитаться — иначе она показывала бы устаревшее.
let purposeTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => campaignForm.purposeTemplate, () => {
  if (!campaignFile.value) return;
  clearTimeout(purposeTimer);
  purposeTimer = setTimeout(() => void loadCampaignPreview(), 500);
});

function selectCampaignFile(event: Event) {
  campaignFile.value = (event.target as HTMLInputElement).files?.[0] || null;
  if (campaignFile.value && !campaignForm.name.trim()) {
    campaignForm.name = campaignFile.value.name.replace(/\.csv$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
  }
  void loadCampaignPreview();
}

function downloadCsvExample() {
  const example = "phone,name,purpose,order_id\n+79001234567,Иван,Подтвердить запись на завтра,A-101\n+79007654321,Анна,Уточнить удобное время,A-102\n";
  const url = URL.createObjectURL(new Blob([example], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "campaign-example.csv";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function createCampaign() {
  if (!campaignFile.value) return notify("Выберите CSV-файл с контактами");
  campaignSaving.value = true;
  try {
    const body = new FormData();
    body.set("file", campaignFile.value);
    body.set("name", campaignForm.name);
    body.set("agentId", campaignForm.agentId);
    body.set("connectionId", campaignForm.connectionId);
    body.set("purposeTemplate", campaignForm.purposeTemplate);
    body.set("intervalSeconds", String(Math.round(campaignForm.interval * (campaignForm.unit === "hours" ? 3600 : 60))));
    const result = await apiFetch<{ campaign: CallCampaign; import: { imported: number; invalid: number; duplicates: number } }>("/api/voice/campaigns", { method: "POST", body });
    const skipped = result.import.invalid + result.import.duplicates;
    notify(`Загружено ${result.import.imported} контактов${skipped ? `, пропущено ${skipped}` : ""}`);
    campaignCreator.value = false;
    Object.assign(campaignForm, { name: "", agentId: "", connectionId: "", purposeTemplate: "", interval: 5, unit: "minutes" });
    campaignFile.value = null;
    campaignPreview.value = null;
    campaignPreviewError.value = "";
    if (campaignFileInput.value) campaignFileInput.value.value = "";
    await loadCampaigns();
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось создать кампанию");
  } finally {
    campaignSaving.value = false;
  }
}

async function campaignAction(campaign: CallCampaign, action: "start" | "pause" | "resume" | "retry_failed") {
  try {
    await apiFetch(`/api/voice/campaigns/${encodeURIComponent(campaign.id)}`, { method: "PATCH", body: { action } });
    notify(action === "pause" ? "Обзвон приостановлен" : action === "retry_failed" ? "Ошибочные номера возвращены в очередь" : "Обзвон запущен");
    await loadCampaigns();
    if (campaignDetails.value?.id === campaign.id) await openCampaign(campaign.id);
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось изменить кампанию");
  }
}

async function openCampaign(id: string) {
  try {
    const result = await apiFetch<{ campaign: CallCampaign }>(`/api/voice/campaigns/${encodeURIComponent(id)}`);
    campaignDetails.value = result.campaign;
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось загрузить базу");
  }
}

async function removeCampaign(campaign: CallCampaign) {
  if (!confirm(`Удалить кампанию «${campaign.name}» и её загруженную базу?`)) return;
  try {
    await apiFetch(`/api/voice/campaigns/${encodeURIComponent(campaign.id)}`, { method: "DELETE" });
    if (campaignDetails.value?.id === campaign.id) campaignDetails.value = null;
    await loadCampaigns();
    notify("Кампания удалена");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось удалить кампанию");
  }
}

function campaignProgress(campaign: CallCampaign) {
  const done = campaign.counts.completed + campaign.counts.failed;
  return campaign.counts.total ? Math.round(done / campaign.counts.total * 100) : 0;
}

function intervalLabel(seconds: number) {
  return seconds % 3600 === 0 ? `${seconds / 3600} ч` : `${Math.round(seconds / 60)} мин`;
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
watch(() => campaignForm.agentId, (agentId) => {
  const matching = connections.value.filter((connection) => connection.agentId === agentId);
  if (!matching.some((connection) => connection.id === campaignForm.connectionId)) {
    campaignForm.connectionId = matching.length === 1 ? matching[0]?.id || "" : "";
  }
});
watch([busy, campaignBusy], ([callsActive, campaignsActive]) => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = callsActive || campaignsActive ? setInterval(refresh, 4000) : undefined;
}, { immediate: true });

onMounted(async () => {
  await refresh();
  try {
    const result = await apiFetch<{ agents: Agent[] }>("/api/voice/agents");
    agents.value = result.agents || [];
    const settings = await apiFetch<VoiceSettings>("/api/voice/settings");
    connections.value = (settings.phoneConnections || []).filter((item) => item.enabled && item.passwordConfigured && item.registrar && item.username);
    const routedAgents = [...new Set(connections.value.map((connection) => connection.agentId).filter(Boolean))];
    const routedAgent = routedAgents.length === 1 ? routedAgents[0] : "";
    if (!campaignForm.agentId && routedAgent && agents.value.some((agent) => agent.id === routedAgent && agent.active)) {
      campaignForm.agentId = routedAgent;
    }
  } catch { /* Calls remain usable with the default agent. */ }
});
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<template>
  <div class="page-header">
    <div><h1>Звонки</h1><p>Входящие и исходящие звонки, расшифровки и итоги сохраняются автоматически.</p></div>
    <div class="page-actions"><button class="ghost-button" @click="toggleCampaignCreator"><X v-if="campaignCreator" :size="16" /><Users v-else :size="16" /> {{ campaignCreator ? "Отмена" : "Обзвон базы" }}</button><button class="primary-button" @click="toggleDialer"><X v-if="dialer" :size="16" /><PhoneOutgoing v-else :size="16" /> {{ dialer ? "Отмена" : "Позвонить" }}</button></div>
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

  <section v-if="campaignCreator" class="call-launcher campaign-launcher">
    <header><div><h2>Новая кампания обзвона</h2><p>Загрузите CSV — агент будет брать по одному контакту через выбранный интервал.</p></div><button class="ghost-button" @click="downloadCsvExample"><FileDown :size="15" /> Скачать пример CSV</button></header>
    <div class="campaign-upload">
      <label class="campaign-file"><span><FileUp :size="17" /> CSV-база</span><input ref="campaignFileInput" type="file" accept=".csv,text/csv" @change="selectCampaignFile"><small>{{ campaignFile ? `${campaignFile.name} · ${Math.ceil(campaignFile.size / 1024)} КБ` : "Колонки: phone/телефон, name/имя, purpose/задача. Остальные колонки станут переменными промпта." }}</small></label>
    <div v-if="!campaignFile && !campaignPreviewLoading" class="campaign-preview _sample">
      <header><strong>Так должен выглядеть файл</strong><small>Первая строка — заголовки колонок</small></header>
      <div class="campaign-preview-scroll">
        <table>
          <thead><tr><th>phone</th><th>name</th><th>purpose</th><th>order_id</th></tr></thead>
          <tbody>
            <tr><td class="preview-phone">+79001234567</td><td>Иван</td><td>Подтвердить запись на завтра</td><td>A-101</td></tr>
            <tr><td class="preview-phone">89007654321</td><td>Анна</td><td>Уточнить удобное время</td><td>A-102</td></tr>
          </tbody>
        </table>
      </div>
      <small>Обязательна только колонка <code>phone</code> (или <code>телефон</code>). <code>name</code> и <code>purpose</code> — по желанию, любые другие колонки станут переменными промпта. Номера в любом формате: +7, 8, с пробелами и скобками.</small>
    </div>
    <div v-if="campaignPreviewLoading" class="campaign-preview _loading">Разбираю файл…</div>
    <p v-else-if="campaignPreviewError" class="campaign-preview-error">{{ campaignPreviewError }}</p>
    <div v-else-if="campaignPreview" class="campaign-preview">
      <header>
        <span class="preview-chip _ok">Загрузим {{ campaignPreview.total }}</span>
        <span v-if="campaignPreview.duplicates" class="preview-chip">Дубликатов {{ campaignPreview.duplicates }}</span>
        <span v-if="campaignPreview.invalid" class="preview-chip _warn">Без номера {{ campaignPreview.invalid }}</span>
        <small v-if="campaignPreview.total > campaignPreview.shown">Показаны первые {{ campaignPreview.shown }} из {{ campaignPreview.total }}</small>
      </header>
      <div class="campaign-preview-scroll">
        <table>
          <thead><tr><th>#</th><th>Телефон</th><th>Имя</th><th>Задача звонка</th><th v-for="key in campaignPreview.extraKeys" :key="key">{{ key }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in campaignPreview.rows" :key="row.phone">
              <td class="preview-index">{{ index + 1 }}</td>
              <td class="preview-phone">{{ row.phone }}</td>
              <td>{{ row.name || "—" }}</td>
              <td class="preview-purpose">{{ row.purpose || "—" }}</td>
              <td v-for="key in campaignPreview.extraKeys" :key="key">{{ row.extra[key] || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <small v-if="campaignPreview.extraKeys.length">Колонки {{ campaignPreview.extraKeys.join(", ") }} станут переменными промпта.</small>
    </div>
    </div>

    <div class="processing-grid">
      <label>Название кампании<input v-model="campaignForm.name" placeholder="Подтверждение записей"></label>
      <label>Агент<select v-model="campaignForm.agentId"><option value="">Выберите агента</option><option v-for="item in agents" :key="item.id" :value="item.id" :disabled="!item.active">{{ item.name }}{{ item.active ? "" : " (выключен)" }}</option></select></label>
      <label>SIP-номер<select v-model="campaignForm.connectionId"><option value="">Выберите подключение</option><option v-for="item in connections" :key="item.id" :value="item.id">{{ item.name }} · {{ item.number || item.username }}</option></select></label>
      <label>Интервал между звонками<div class="campaign-interval"><input v-model.number="campaignForm.interval" type="number" min="1" :max="campaignForm.unit === 'hours' ? 24 : 1440"><select v-model="campaignForm.unit"><option value="minutes">минут</option><option value="hours">часов</option></select></div></label>
      <label class="wide">Общая задача звонка <i>если в CSV нет колонки purpose</i><textarea v-model="campaignForm.purposeTemplate" rows="3" placeholder="Подтвердить запись и уточнить удобное время"></textarea></label>
    </div>
    <footer><small>До 5000 уникальных номеров. Кампания создаётся на паузе — проверьте базу и нажмите «Запустить».</small><button class="primary-button" :disabled="campaignSaving || campaignPreviewLoading || !campaignPreview?.total || !campaignForm.name.trim() || !campaignForm.agentId || !campaignForm.connectionId" @click="createCampaign">{{ campaignSaving ? "Загружаем…" : "Создать кампанию" }}</button></footer>
  </section>

  <section v-if="campaigns.length" class="campaigns-section">
    <header><div><h2>Кампании обзвона</h2><p>Звонки идут последовательно и не пересекаются внутри одной кампании.</p></div><span>{{ campaigns.filter((item) => item.status === 'running').length }} активных</span></header>
    <div class="campaign-grid">
      <article v-for="campaign in campaigns" :key="campaign.id" :class="campaign.status">
        <button class="campaign-main" @click="openCampaign(campaign.id)"><span class="call-status" :class="campaign.status === 'running' ? 'live' : campaign.status === 'completed' ? 'ended' : ''">{{ campaign.status === "draft" ? "Не запущена" : campaign.status === "running" ? "Идёт обзвон" : campaign.status === "paused" ? "Пауза" : "Завершена" }}</span><strong>{{ campaign.name }}</strong><small>каждые {{ intervalLabel(campaign.intervalSeconds) }}</small></button>
        <div class="campaign-progress"><i :style="{ width: `${campaignProgress(campaign)}%` }"></i></div>
        <div class="campaign-counts"><span><b>{{ campaign.counts.completed }}</b> успешно</span><span><b>{{ campaign.counts.failed }}</b> ошибок</span><span><b>{{ campaign.counts.pending }}</b> в очереди</span><span>{{ campaignProgress(campaign) }}%</span></div>
        <footer><button v-if="campaign.status === 'running'" class="ghost-button" @click="campaignAction(campaign, 'pause')"><Pause :size="14" /> Пауза</button><button v-else-if="campaign.status !== 'completed' || campaign.counts.pending" class="primary-button" @click="campaignAction(campaign, campaign.status === 'paused' ? 'resume' : 'start')"><Play :size="14" /> Запустить</button><button v-if="campaign.counts.failed" class="ghost-button" @click="campaignAction(campaign, 'retry_failed')"><ListRestart :size="14" /> Повторить ошибки</button><button v-if="campaign.status !== 'running'" class="icon-button" aria-label="Удалить кампанию" @click="removeCampaign(campaign)"><Trash2 :size="15" /></button></footer>
      </article>
    </div>
  </section>

  <section v-if="campaignDetails" class="campaign-details">
    <header><div><h2>{{ campaignDetails.name }}</h2><p>{{ campaignDetails.counts.total }} контактов · интервал {{ intervalLabel(campaignDetails.intervalSeconds) }}</p></div><button class="dialog-close" aria-label="Закрыть" @click="campaignDetails = null"><X :size="16" /></button></header>
    <div class="campaign-recipient-table"><div class="campaign-recipient-head"><span>Контакт</span><span>Телефон</span><span>Статус</span><span>Попыток</span></div><div v-for="recipient in campaignDetails.recipients" :key="recipient.id" class="campaign-recipient-row"><span><strong>{{ recipient.name || "Без имени" }}</strong><small>{{ recipient.variables.caller_purpose }}</small></span><span>{{ recipient.phone }}</span><span class="call-status" :class="recipient.status === 'completed' ? 'ended' : recipient.status === 'failed' ? 'failed' : ['dialing','dispatching'].includes(recipient.status) ? 'live' : ''">{{ recipient.status === "pending" ? "В очереди" : recipient.status === "dispatching" ? "Запускаем" : recipient.status === "dialing" ? "Звоним" : recipient.status === "completed" ? "Завершён" : recipient.status === "failed" ? "Ошибка" : "Пропущен" }}</span><span>{{ recipient.attempts }}</span><p v-if="recipient.error">{{ recipient.error }}</p></div></div>
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
