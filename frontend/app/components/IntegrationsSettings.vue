<script setup lang="ts">
import { ArrowLeft, ExternalLink, Save } from "@lucide/vue";
import type { VoiceSettings } from "~/types/voice";

const props = defineProps<{ settings: VoiceSettings; saving: boolean }>();
const emit = defineEmits<{ back: []; save: [settings: VoiceSettings] }>();

const draft = ref<VoiceSettings>(structuredClone(toRaw(props.settings)));
const checks = reactive<Record<string, { ok?: boolean; detail: string }>>({});
const serviceAccountEmail = ref("");

watch(() => props.settings, (next) => { draft.value = structuredClone(toRaw(next)); }, { deep: true });

onMounted(async () => {
  try {
    const info = await apiFetch<{ serviceAccountEmail: string }>("/api/voice/integrations/check");
    serviceAccountEmail.value = info.serviceAccountEmail;
  } catch {
    // Адрес сервисного аккаунта — подсказка, а не условие работы страницы.
  }
});

// Проверять имеет смысл только сохранённые настройки: запрос уходит с backend,
// а он видит то, что лежит в базе, а не черновик в форме.
async function check(id: string) {
  checks[id] = { detail: "Проверяю…" };
  try {
    const result = await apiFetch<{ ok: boolean; detail?: string; error?: string }>("/api/voice/integrations/check", { method: "POST", body: { id } });
    checks[id] = { ok: result.ok, detail: result.detail || result.error || "Нет ответа" };
  } catch (failure) {
    checks[id] = { ok: false, detail: failure instanceof Error ? failure.message : "Проверка не выполнена" };
  }
}
</script>

<template>
  <div class="voice-connection">
    <header class="voice-editor-header">
      <button @click="emit('back')"><ArrowLeft :size="16" /></button>
      <div><h1>Интеграции</h1><p>Итог каждого завершённого звонка уходит в подключённые системы сам. Токены остаются на backend.</p></div>
    </header>

    <div class="provider-settings-grid">
      <section class="voice-settings-card">
        <div class="voice-settings-heading">
          <span class="plogo"><img src="/logos/bitrix24.svg" alt="Bitrix24" width="40" height="40"></span>
          <div><h2>Bitrix24</h2><p>Звонок ложится в карточку клиента с записью и расшифровкой.</p></div>
          <span class="conn-status" :class="{ _ok: settings.bitrixWebhookConfigured }">{{ settings.bitrixWebhookConfigured ? "Подключён" : "Не подключён" }}</span>
        </div>
        <div class="voice-settings-grid">
          <label class="wide">
            Ссылка входящего вебхука
            <input v-model="draft.bitrixWebhookUrl" type="password" autocomplete="off" :placeholder="settings.bitrixWebhookConfigured ? 'Уже сохранена — оставьте пустым' : 'https://ваш-портал.bitrix24.ru/rest/1/токен/'">
            <small>В Bitrix24: Приложения → Разработчикам → Другое → Входящий вебхук. Нужное право — <b>crm</b>. Ответственного за звонок берём из самой ссылки.</small>
          </label>
        </div>
        <p class="provider-check">
          <button class="ghost-button" @click="check('bitrix')">Проверить Bitrix24</button>
          <span v-if="checks.bitrix" :class="checks.bitrix.ok ? 'ok' : checks.bitrix.ok === false ? 'bad' : ''">{{ checks.bitrix.detail }}</span>
        </p>
      </section>

      <section class="voice-settings-card">
        <div class="voice-settings-heading">
          <span class="plogo"><img src="/logos/amocrm.svg" alt="amoCRM" width="40" height="40"></span>
          <div><h2>amoCRM</h2><p>Звонок добавляется контакту. Незнакомый номер сначала создаётся контактом.</p></div>
          <span class="conn-status" :class="{ _ok: settings.amoAccessTokenConfigured }">{{ settings.amoAccessTokenConfigured ? "Подключён" : "Не подключён" }}</span>
        </div>
        <div class="voice-settings-grid">
          <label>Адрес аккаунта<input v-model="draft.amoBaseUrl" placeholder="https://ваш-аккаунт.amocrm.ru"></label>
          <label>
            Долгосрочный токен
            <input v-model="draft.amoAccessToken" type="password" autocomplete="off" :placeholder="settings.amoAccessTokenConfigured ? 'Токен уже сохранён' : 'eyJ0eXAi...'">
          </label>
          <small class="wide">В amoCRM: Настройки → Интеграции → создать внешнюю интеграцию → вкладка «Ключи и доступы» → долгосрочный токен. OAuth не нужен.</small>
        </div>
        <p class="provider-check">
          <button class="ghost-button" @click="check('amocrm')">Проверить amoCRM</button>
          <span v-if="checks.amocrm" :class="checks.amocrm.ok ? 'ok' : checks.amocrm.ok === false ? 'bad' : ''">{{ checks.amocrm.detail }}</span>
        </p>
      </section>

      <section class="voice-settings-card">
        <div class="voice-settings-heading">
          <span class="plogo"><img src="/logos/sheets.svg" alt="Google Таблицы" width="40" height="40"></span>
          <div><h2>Google Таблицы</h2><p>Каждый звонок — строка: время, номер, итог, ссылка на запись, расшифровка.</p></div>
          <span class="conn-status" :class="{ _ok: settings.sheetsSpreadsheetId && (settings.sheetsSharedKeyAvailable || settings.sheetsServiceAccountConfigured) }">
            {{ settings.sheetsSpreadsheetId && (settings.sheetsSharedKeyAvailable || settings.sheetsServiceAccountConfigured) ? "Подключены" : "Не подключены" }}
          </span>
        </div>
        <div class="voice-settings-grid">
          <label class="wide">
            Ссылка на таблицу
            <input v-model="draft.sheetsSpreadsheetId" placeholder="https://docs.google.com/spreadsheets/d/...">
            <small v-if="serviceAccountEmail">Откройте таблицу → «Поделиться» → дайте право <b>Редактор</b> адресу <code>{{ serviceAccountEmail }}</code></small>
          </label>
          <label>Лист<input v-model="draft.sheetsSheetName" placeholder="Пусто — первый лист"></label>
        </div>
        <p v-if="!settings.sheetsSharedKeyAvailable && !settings.sheetsServiceAccountConfigured" class="integration-warning">
          На сервере не задан общий ключ сервисного аккаунта Google (<code>GOOGLE_SERVICE_ACCOUNT_KEY</code>). Пока его нет, укажите свой ключ ниже — иначе выгрузка в таблицы работать не будет.
        </p>
        <details class="integration-advanced">
          <summary>Свой сервисный аккаунт</summary>
          <label class="wide">
            JSON-ключ
            <textarea v-model="draft.sheetsServiceAccountKey" rows="4" autocomplete="off" :placeholder="settings.sheetsServiceAccountConfigured ? 'Ключ уже сохранён' : '{ &quot;client_email&quot;: ..., &quot;private_key&quot;: ... }'"></textarea>
            <small>Нужен, только если вы не хотите давать доступ к таблице нашему сервисному аккаунту. Перекрывает общий ключ.</small>
          </label>
        </details>
        <p class="provider-check">
          <button class="ghost-button" @click="check('sheets')">Проверить таблицу</button>
          <span v-if="checks.sheets" :class="checks.sheets.ok ? 'ok' : checks.sheets.ok === false ? 'bad' : ''">{{ checks.sheets.detail }}</span>
        </p>
      </section>

      <section class="voice-settings-card">
        <div class="voice-settings-heading">
          <div><h2>Запись разговора в CRM</h2><p>Ссылка на запись прикладывается к звонку в карточке клиента.</p></div>
          <label class="switch"><input v-model="draft.attachRecording" type="checkbox" :disabled="!settings.recordingLinksAvailable"><span></span></label>
        </div>
        <p v-if="!settings.recordingLinksAvailable" class="integration-warning">
          На сервере не задан <code>RECORDING_LINK_SECRET</code> — ссылки не выдаются, тумблер ничего не изменит. Выгрузка при этом работает, просто без записи.
        </p>
        <p v-else class="integration-warning">
          Ссылка открывается <b>без входа в панель</b>: любой, у кого она есть, услышит разговор. Это нужно, чтобы запись слушалась прямо из CRM. Отзывается сменой <code>RECORDING_LINK_SECRET</code> на сервере — сразу для всех выданных ссылок.
        </p>
      </section>
    </div>

    <footer class="voice-editor-actions">
      <button class="ghost-button" @click="emit('back')">Отмена</button>
      <button class="primary-button" :disabled="saving" @click="emit('save', draft)"><Save :size="15" /> {{ saving ? "Сохраняем…" : "Сохранить" }}</button>
    </footer>
  </div>
</template>
