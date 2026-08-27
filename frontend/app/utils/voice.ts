import type { Agent, PhoneConnection, Provider, VoiceSettings } from "~/types/voice";

export const providerLabels: Record<Provider, string> = {
  yandex: "Yandex AI Studio", deepseek: "DeepSeek", openai: "OpenAI", xai: "xAI Grok Voice",
};

export const models: Array<{ id: string; provider: Provider; label: string; note: string }> = [
  { id: "speech-realtime-260528", provider: "yandex", label: "Speech Realtime 260528", note: "Основная модель Yandex" },
  { id: "speech-realtime-250923", provider: "yandex", label: "Speech Realtime 250923", note: "Предыдущая стабильная версия" },
  { id: "speech-realtime-deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash Realtime", note: "Экспериментальная модель" },
  { id: "grok-voice-think-fast-2.0", provider: "xai", label: "Grok Voice Think Fast 2.0", note: "Realtime-модель xAI" },
  { id: "gpt-realtime-2.1", provider: "openai", label: "GPT Realtime 2.1", note: "Флагманская модель OpenAI" },
  { id: "gpt-realtime-2.1-mini", provider: "openai", label: "GPT Realtime 2.1 mini", note: "Быстрее и экономичнее" },
  { id: "gpt-realtime-2", provider: "openai", label: "GPT Realtime 2", note: "Предыдущее поколение" },
  { id: "gpt-realtime-1.5", provider: "openai", label: "GPT Realtime 1.5", note: "Совместимая стабильная версия" },
];

export const voices: Record<Provider, string[]> = {
  yandex: ["filipp", "alena", "ermil", "jane", "omazh", "zahar", "dasha", "julia", "lera", "masha", "marina", "alexander", "kirill", "anton"],
  deepseek: ["filipp", "alena", "ermil", "jane", "dasha", "julia"],
  openai: ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
  xai: ["xai_rex", "xai_sal", "xai_helios", "xai_castor", "xai_helix", "xai_ursa", "xai_kepler", "xai_lumen", "xai_luna", "xai_atlas", "xai_eve", "xai_sirius"],
};

export const builtins = [
  ["contact_context", "Память и карточка клиента"],
  ["update_contact", "Изменить контакт"],
  ["move_pipeline", "Переместить по воронке"],
  ["remember_note", "Запомнить факт"],
  ["transfer_call", "Перевести оператору"],
  ["end_call", "Завершить звонок"],
  ["search_knowledge", "Поиск по базе знаний"],
] as const;

export const timezones = ["Europe/Kaliningrad", "Europe/Moscow", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Vladivostok", "Asia/Almaty", "Europe/Minsk", "UTC"];

export const templates = {
  support: "Ты — голосовой оператор службы поддержки сервиса {{service_name}}. Прими обращение, уточни детали и помоги решить вопрос. Говори коротко, естественно и вежливо. Не выдумывай факты. Если вопрос требует человека — используй перевод звонка.",
  sales: "Ты — голосовой менеджер по продажам компании {{company_name}}. Выясни задачу клиента, квалифицируй потребность и предложи подходящий следующий шаг. Сохраняй важные факты в CRM и не дави на клиента.",
  assistant: "Ты — голосовой ассистент {{owner_name}}. Ты звонишь по его поручению и доводишь задачу {{caller_purpose}} до результата. В автоответчике используй тональный набор, к живому человеку переходи короткими естественными репликами.",
};

export const emptySettings: VoiceSettings = {
  yandexFolderId: "", yandexApiKey: "", gatewayPublicUrl: "", openaiApiKey: "", openaiProjectId: "", xaiApiKey: "",
  smtpHost: "", smtpPort: 587, smtpUser: "", smtpPassword: "", smtpFrom: "",
  bitrixWebhookUrl: "", amoBaseUrl: "", amoAccessToken: "",
  sheetsSpreadsheetId: "", sheetsSheetName: "", sheetsServiceAccountKey: "",
  attachRecording: true, phoneConnections: [],
};

export function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function freshAgent(): Agent {
  return {
    id: "", name: "Новый голосовой агент", description: "", provider: "yandex", model: "speech-realtime-260528",
    instructions: templates.support, variables: [{ id: uid(), key: "service_name", value: "" }],
    tools: [
      { id: uid(), type: "ascn", name: "contact_context" },
      { id: uid(), type: "ascn", name: "update_contact" },
      { id: uid(), type: "ascn", name: "remember_note" },
    ],
    synthesisEnabled: true, voice: "filipp", role: "", speed: 1, recognitionLanguage: "auto",
    vadEnabled: true, vadThreshold: 0.5, silenceDurationMs: 800, speaksFirst: false, firstMessage: "Здравствуйте! Чем могу помочь?",
    maxCallSeconds: 0, ambientSound: "none", ambientVolume: 0.3, outputGain: 1.6,
    guardrails: "", pronunciations: [], keyterms: "", followUpSeconds: 0, followUpMessage: "",
    allowInterruptions: true, shareCallerNumber: true, timezone: "Europe/Moscow", avatar: "", notifyEmail: "", knowledge: [], active: true,
  };
}

export function newPhoneConnection(index: number, agentId = ""): PhoneConnection {
  return {
    id: uid(), name: index ? `Номер ${index + 1}` : "Основной номер", providerPreset: "sipnet", dialFormat: "ru7", fromUser: "login",
    enabled: false, number: "", agentId, registrar: "sipnet.ru", proxy: "", username: "", password: "", transport: "udp",
    operatorExtension: "", mode: "register", allowedAddresses: [],
  };
}

export function sinceText(iso?: string) {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} дн назад` : new Date(at).toLocaleDateString("ru-RU");
}
