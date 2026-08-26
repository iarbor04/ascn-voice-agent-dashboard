<script setup lang="ts">
import { ArrowLeft, ExternalLink, Phone, Plus, Save, Trash2 } from "@lucide/vue";
import type { Agent, PhoneConnection, VoiceSettings } from "~/types/voice";
import { newPhoneConnection, providerLabels } from "~/utils/voice";

const props = defineProps<{ agents: Agent[]; settings: VoiceSettings; saving: boolean }>();
const emit = defineEmits<{ back: []; save: [settings: VoiceSettings] }>();
const draft = ref<VoiceSettings>(structuredClone(toRaw(props.settings)));
const checks = reactive<Record<string, { ok?: boolean; detail: string }>>({});

watch(() => props.settings, (next) => { draft.value = structuredClone(toRaw(next)); }, { deep: true });

function addPhone() {
  draft.value.phoneConnections.push(newPhoneConnection(draft.value.phoneConnections.length, props.agents[0]?.id || ""));
}

function updatePhone(id: string, changes: Partial<PhoneConnection>) {
  const index = draft.value.phoneConnections.findIndex((item) => item.id === id);
  const current = draft.value.phoneConnections[index];
  if (index >= 0 && current) draft.value.phoneConnections[index] = { ...current, ...changes };
}

async function checkProvider(provider: string) {
  checks[provider] = { detail: "Проверяю…" };
  try {
    const result = await apiFetch<{ ok: boolean; detail?: string; error?: string }>("/api/voice/settings/check", { method: "POST", body: { provider } });
    checks[provider] = { ok: result.ok, detail: result.detail || result.error || "Нет ответа" };
  } catch (failure) {
    checks[provider] = { ok: false, detail: failure instanceof Error ? failure.message : "Проверка не выполнена" };
  }
}

function addAddress(connection: PhoneConnection, value: string) {
  const address = value.trim();
  if (address && !connection.allowedAddresses.includes(address)) connection.allowedAddresses.push(address);
}
</script>

<template>
  <div class="voice-connection">
    <header class="voice-editor-header"><button @click="emit('back')"><ArrowLeft :size="16" /></button><div><h1>Подключение и номера</h1><p>Ключи AI-провайдеров, SIP-подключения и SMTP. Секреты остаются на backend.</p></div></header>
    <div class="setup-progress">
      <div :class="{ _done: settings.yandexApiKeyConfigured || settings.openaiApiKeyConfigured || settings.xaiApiKeyConfigured }"><i>{{ settings.yandexApiKeyConfigured || settings.openaiApiKeyConfigured || settings.xaiApiKeyConfigured ? "✓" : "1" }}</i><div><strong>Ключ провайдера речи</strong><p>Подключите хотя бы одного провайдера</p></div></div>
      <div :class="{ _done: draft.phoneConnections.length }"><i>{{ draft.phoneConnections.length ? "✓" : "2" }}</i><div><strong>Телефонный номер</strong><p>{{ draft.phoneConnections.length ? `Подключено: ${draft.phoneConnections.length}` : "Добавьте SIP-номер" }}</p></div></div>
      <div :class="{ _done: draft.phoneConnections.some((item) => item.agentId) }"><i>{{ draft.phoneConnections.some((item) => item.agentId) ? "✓" : "3" }}</i><div><strong>Агент на номере</strong><p>Endpoint будет связан с выбранным агентом и tenant</p></div></div>
    </div>

    <div class="provider-settings-grid">
      <section class="voice-settings-card"><div class="voice-settings-heading"><span class="plogo"><img src="/logos/xai.png" alt="xAI" width="40" height="40"></span><div><h2>xAI Grok Voice</h2><p>Grok Voice Think Fast.</p></div><span class="conn-status" :class="{ _ok: settings.xaiApiKeyConfigured }">{{ settings.xaiApiKeyConfigured ? "Подключён" : "Не подключён" }}</span><a class="provider-link" href="https://console.x.ai/" target="_blank">Создать ключ <ExternalLink :size="14" /></a></div><div class="voice-settings-grid"><label class="wide">API-ключ<input v-model="draft.xaiApiKey" type="password" autocomplete="off" :placeholder="settings.xaiApiKeyConfigured ? 'Ключ уже сохранён — оставьте пустым' : 'xai-...' "></label></div><p class="provider-check"><button class="ghost-button" @click="checkProvider('xai')">Проверить xAI</button><span v-if="checks.xai" :class="checks.xai.ok ? 'ok' : checks.xai.ok === false ? 'bad' : ''">{{ checks.xai.detail }}</span></p></section>
      <section class="voice-settings-card"><div class="voice-settings-heading"><span class="plogo"><img src="/logos/yandex.png" alt="Yandex" width="40" height="40"></span><div><h2>Yandex AI Studio</h2><p>Speech Realtime и DeepSeek.</p></div><span class="conn-status" :class="{ _ok: settings.yandexApiKeyConfigured }">{{ settings.yandexApiKeyConfigured ? "Подключён" : "Не подключён" }}</span></div><div class="voice-settings-grid"><label>Идентификатор каталога<input v-model="draft.yandexFolderId" placeholder="b1g..."></label><label>API-ключ<input v-model="draft.yandexApiKey" type="password" autocomplete="off" :placeholder="settings.yandexApiKeyConfigured ? 'Ключ уже сохранён' : 'AQVN...' "></label></div><p class="provider-check"><button class="ghost-button" @click="checkProvider('yandex')">Проверить Yandex</button><span v-if="checks.yandex" :class="checks.yandex.ok ? 'ok' : checks.yandex.ok === false ? 'bad' : ''">{{ checks.yandex.detail }}</span></p></section>
      <section class="voice-settings-card"><div class="voice-settings-heading"><span class="plogo"><img src="/logos/openai.png" alt="OpenAI" width="40" height="40"></span><div><h2>OpenAI Realtime</h2><p>GPT Realtime.</p></div><span class="conn-status" :class="{ _ok: settings.openaiApiKeyConfigured }">{{ settings.openaiApiKeyConfigured ? "Подключён" : "Не подключён" }}</span></div><div class="voice-settings-grid"><label>API-ключ<input v-model="draft.openaiApiKey" type="password" autocomplete="off" :placeholder="settings.openaiApiKeyConfigured ? 'Ключ уже сохранён' : 'sk-proj-...' "></label><label>Project ID<input v-model="draft.openaiProjectId" placeholder="proj_..."></label></div><p class="provider-check"><button class="ghost-button" @click="checkProvider('openai')">Проверить OpenAI</button><span v-if="checks.openai" :class="checks.openai.ok ? 'ok' : checks.openai.ok === false ? 'bad' : ''">{{ checks.openai.detail }}</span></p></section>
    </div>

    <details class="advanced-conn"><summary>Дополнительно: gateway и почта</summary><div class="voice-settings-grid"><label class="wide">Публичный адрес voice gateway<input v-model="draft.gatewayPublicUrl" placeholder="wss://voice.example.ru/voice-ws/session"></label><label>SMTP host<input v-model="draft.smtpHost" placeholder="smtp.example.ru"></label><label>SMTP port<input v-model.number="draft.smtpPort" type="number" min="1" max="65535"></label><label>SMTP user<input v-model="draft.smtpUser"></label><label>SMTP password<input v-model="draft.smtpPassword" type="password" :placeholder="settings.smtpPasswordConfigured ? 'Пароль уже сохранён' : ''"></label><label class="wide">От кого<input v-model="draft.smtpFrom" placeholder="voice@example.ru"></label></div></details>

    <section class="phone-connections-section">
      <div class="phone-connections-heading"><div><h2>Номера и агенты</h2><p>Каждый SIP endpoint жёстко связан с connection и tenant на backend.</p></div><button class="ghost-button" @click="addPhone"><Plus :size="15" /> Добавить номер</button></div>
      <div v-if="!draft.phoneConnections.length" class="phone-empty"><Phone /><p>Номера ещё не добавлены.</p><button class="primary-button" @click="addPhone">Добавить первый номер</button></div>
      <section v-for="connection in draft.phoneConnections" :key="connection.id" class="voice-settings-card phone-connection-card">
        <div class="voice-settings-heading"><Phone /><div><h2>{{ connection.name || "Телефонный номер" }}</h2><p>{{ connection.number || "Номер пока не указан" }}</p></div><label class="switch"><input v-model="connection.enabled" type="checkbox"><span></span></label><button class="icon-button" :aria-label="`Удалить ${connection.name}`" @click="draft.phoneConnections = draft.phoneConnections.filter((item) => item.id !== connection.id)"><Trash2 :size="16" /></button></div>
        <div class="voice-settings-grid">
          <label>Название<input v-model="connection.name" placeholder="Основной номер"></label>
          <label>Режим<select v-model="connection.mode"><option value="register">Регистрация у оператора</option><option value="direct">Прямой SIP по IP</option></select></label>
          <label>Номер телефона / DID<input v-model="connection.number" placeholder="+7 495 000-00-00"></label>
          <label>Какой агент отвечает<select v-model="connection.agentId"><option value="">Не назначен</option><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }} · {{ providerLabels[agent.provider] }}</option></select></label>
          <template v-if="connection.mode === 'register'">
            <label>Оператор<select v-model="connection.providerPreset" @change="updatePhone(connection.id, connection.providerPreset === 'sipnet' ? { registrar: 'sipnet.ru', dialFormat: 'ru7', fromUser: 'login' } : {})"><option value="sipnet">SIPNET</option><option value="telphin">Телфин</option><option value="mango">MANGO OFFICE</option><option value="novofon">Novofon / Zadarma</option><option value="custom">Другой оператор</option></select></label>
            <label>SIP server / registrar<input v-model="connection.registrar" placeholder="sip.provider.ru"></label>
            <label>Outbound proxy<input v-model="connection.proxy" placeholder="необязательно"></label>
            <label>SIP логин<input v-model="connection.username"></label>
            <label>SIP пароль<input v-model="connection.password" type="password" :placeholder="connection.passwordConfigured ? 'Пароль уже сохранён' : ''"></label>
            <label>Транспорт<select v-model="connection.transport"><option value="udp">UDP</option><option value="tcp">TCP</option></select></label>
          </template>
          <template v-else>
            <label class="wide">Разрешённый публичный IP /32<input :value="connection.allowedAddresses.join(', ')" placeholder="203.0.113.10" @change="connection.allowedAddresses = ($event.target as HTMLInputElement).value.split(',').map((item) => item.trim()).filter(Boolean)"><small>Backend принимает только зарезервированные администратором публичные IPv4.</small></label>
          </template>
          <label>Добавочный оператора<input v-model="connection.operatorExtension" placeholder="необязательно"></label>
        </div>
      </section>
    </section>
    <footer class="voice-editor-actions"><button class="ghost-button" @click="emit('back')">Отмена</button><button class="primary-button" :disabled="saving" @click="emit('save', draft)"><Save :size="15" /> {{ saving ? "Сохраняем…" : "Сохранить" }}</button></footer>
  </div>
</template>
