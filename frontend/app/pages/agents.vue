<script setup lang="ts">
import { Bot, Briefcase, CalendarDays, Headphones, Plug, Plus, Search, Settings2, Trash2, TrendingUp, X } from "@lucide/vue";
import type { Agent, PhoneConnection, VoiceSettings } from "~/types/voice";
import { emptySettings, freshAgent, models, sinceText, templates, uid } from "~/utils/voice";

const { notify } = useToast();
const agents = ref<Agent[]>([]);
const selected = ref<Agent | null>(null);
const settings = ref<VoiceSettings>({ ...emptySettings, phoneConnections: [] });
const search = ref("");
const loading = ref(true);
const saving = ref(false);
const showSettings = ref(false);
const showIntegrations = ref(false);
const builder = ref<{ seed: string; starter?: () => Agent } | null>(null);

const visibleAgents = computed(() => agents.value.filter((item) => {
  const query = search.value.trim().toLowerCase();
  return !query || item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
}));

const starters = [
  { label: "Оператор поддержки", icon: Headphones, tone: "peach", create: () => ({ ...freshAgent(), name: "Оператор поддержки", description: "Отвечает на входящие и решает вопросы клиентов" }) },
  { label: "Менеджер продаж", icon: TrendingUp, tone: "mint", create: () => ({ ...freshAgent(), name: "Менеджер продаж", description: "Квалифицирует потребность и доводит до заказа", instructions: templates.sales, variables: [{ id: uid(), key: "company_name", value: "" }] }) },
  { label: "Запись на приём", icon: CalendarDays, tone: "amber", create: () => ({ ...freshAgent(), name: "Запись на приём", description: "Согласует дату и подтверждает запись", speaksFirst: true, firstMessage: "Здравствуйте! Записываю на удобное время." }) },
  { label: "Личный ассистент", icon: Briefcase, tone: "violet", create: () => ({ ...freshAgent(), name: "Личный ассистент", description: "Звонит по поручению и проходит IVR", instructions: templates.assistant, variables: [{ id: uid(), key: "owner_name", value: "" }, { id: uid(), key: "caller_purpose", value: "" }], tools: [...freshAgent().tools, { id: uid(), type: "dtmf", name: "press_digit" }] }) },
];

function sanitizeSettings(result: VoiceSettings): VoiceSettings {
  return {
    ...emptySettings,
    ...result,
    yandexApiKey: "",
    openaiApiKey: "",
    xaiApiKey: "",
    smtpPassword: "",
    // Секреты backend отдаёт только флагом «настроено». Пустая строка в черновике
    // означает «не менять» — иначе сохранение затёрло бы сохранённый токен.
    bitrixWebhookUrl: "",
    amoAccessToken: "",
    sheetsServiceAccountKey: "",
    phoneConnections: (result.phoneConnections || []).map((item) => ({ ...item, password: "" })),
  };
}

async function load() {
  loading.value = true;
  try {
    const [agentData, settingsData] = await Promise.all([
      apiFetch<{ agents: Agent[] }>("/api/voice/agents"),
      apiFetch<VoiceSettings>("/api/voice/settings"),
    ]);
    agents.value = agentData.agents || [];
    settings.value = sanitizeSettings(settingsData);
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось загрузить агентов");
  } finally {
    loading.value = false;
  }
}

function editAgent(agent: Agent) {
  selected.value = structuredClone(toRaw(agent));
}

async function saveAgent(agent: Agent) {
  saving.value = true;
  try {
    const result = await apiFetch<{ agent: Agent }>("/api/voice/agents", { method: agent.id ? "PUT" : "POST", body: agent });
    selected.value = result.agent;
    const index = agents.value.findIndex((item) => item.id === result.agent.id);
    if (index === -1) agents.value.push(result.agent); else agents.value[index] = result.agent;
    notify("Голосовой агент сохранён");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось сохранить агента");
  } finally {
    saving.value = false;
  }
}

async function publishAgent(agent: Agent, live: boolean) {
  if (!agent.id) return notify("Сначала сохраните агента");
  try {
    const result = await apiFetch<{ agent: Agent }>("/api/voice/agents/publish", { method: "POST", body: { id: agent.id, live } });
    selected.value = result.agent;
    const index = agents.value.findIndex((item) => item.id === result.agent.id);
    if (index >= 0) agents.value[index] = result.agent;
    notify(live ? "Агент опубликован" : "Публикация снята");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось опубликовать агента");
  }
}

async function removeAgent(agent: Agent) {
  if (!confirm(`Удалить агента «${agent.name}»?`)) return;
  try {
    await apiFetch(`/api/voice/agents?id=${encodeURIComponent(agent.id)}`, { method: "DELETE" });
    agents.value = agents.value.filter((item) => item.id !== agent.id);
    if (selected.value?.id === agent.id) selected.value = null;
    notify("Голосовой агент удалён");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось удалить агента");
  }
}

async function saveSettings(next: VoiceSettings) {
  saving.value = true;
  try {
    const result = await apiFetch<VoiceSettings>("/api/voice/settings", { method: "PUT", body: next });
    settings.value = sanitizeSettings(result);
    notify("Подключения и номера сохранены");
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Не удалось сохранить настройки");
  } finally {
    saving.value = false;
  }
}

async function addPhoneNumber(connection: PhoneConnection) {
  const next = { ...settings.value, phoneConnections: [...settings.value.phoneConnections, connection] };
  await saveSettings(next);
}

function openBuiltAgent(draft: Partial<Agent>) {
  builder.value = null;
  selected.value = { ...freshAgent(), ...draft };
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="voice-loading">Загружаем голосовых агентов…</div>
  <ConnectionSettings v-else-if="showSettings" :agents="agents" :settings="settings" :saving="saving" @back="showSettings = false" @save="saveSettings" />
  <IntegrationsSettings v-else-if="showIntegrations" :settings="settings" :saving="saving" @back="showIntegrations = false" @save="saveSettings" />
  <AgentEditor v-else-if="selected" :agent="selected" :settings="settings" :saving="saving" @back="selected = null" @save="saveAgent" @publish="publishAgent" @add-number="addPhoneNumber" />
  <template v-else>
    <div class="page-header"><div><h1>Голосовые агенты</h1><p>Собрать, настроить и проверить голосового агента для телефона.</p></div><div class="page-actions"><button class="ghost-button" @click="showSettings = true"><Settings2 :size="16" /> Подключение и номера</button><button class="ghost-button" @click="showIntegrations = true"><Plug :size="16" /> Интеграции</button><button class="primary-button" @click="builder = { seed: '' }"><Plus :size="16" /> Создать агента</button></div></div>
    <div class="agent-search"><Search :size="15" /><input v-model="search" placeholder="Найти агента" aria-label="Найти агента"><button v-if="search" type="button" aria-label="Сбросить поиск" @click="search = ''"><X :size="14" /></button></div>
    <div v-if="agents.length" class="agent-table">
      <header><span>Агент</span><span>Модель</span><span>Изменён</span><i></i></header>
      <article v-for="item in visibleAgents" :key="item.id">
        <button type="button" class="agent-row-main" @click="editAgent(item)"><span class="agent-row-avatar"><b v-if="item.avatar && !item.avatar.startsWith('data:')">{{ item.avatar }}</b><img v-else-if="item.avatar" :src="item.avatar" alt="" width="30" height="30"><Bot v-else :size="15" /></span><strong>{{ item.name }}</strong><span class="live-badge" :class="item.live ? (item.unpublished ? 'changed' : '') : 'draft'"><i></i>{{ item.live ? (item.unpublished ? "Черновик изменён" : "В эфире") : "Черновик" }}</span><span v-if="!item.active" class="live-badge draft"><i></i>Не принимает</span></button>
        <span class="agent-row-model">{{ models.find((model) => model.id === item.model)?.label || item.model }}</span><time>{{ sinceText(item.updatedAt) }}</time><button class="icon-button agent-row-delete" :aria-label="`Удалить ${item.name}`" @click="removeAgent(item)"><Trash2 :size="15" /></button>
      </article>
      <p v-if="!visibleAgents.length" class="agent-table-empty">По запросу «{{ search }}» агентов нет.</p>
    </div>
    <div class="agent-starters"><button v-for="starter in starters" :key="starter.label" class="starter" :class="starter.tone" @click="builder = { seed: starter.label, starter: starter.create }"><i><component :is="starter.icon" :size="16" /></i>{{ starter.label }}</button><button class="starter blank" @click="selected = { ...freshAgent(), instructions: '' }"><Plus :size="16" /> Начать с нуля</button></div>
    <section v-if="!agents.length" class="empty-state"><div class="add-circle"><Bot :size="21" /></div><h2>Голосовых агентов пока нет</h2><p>Выберите сценарий выше или начните с пустого агента.</p></section>
    <AgentBuilderDialog v-if="builder" :seed="builder.seed" @cancel="builder = null" @skip="openBuiltAgent(builder.starter ? builder.starter() : freshAgent())" @ready="openBuiltAgent" />
  </template>
</template>
