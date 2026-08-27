export type Provider = "yandex" | "deepseek" | "openai" | "xai";

export type Tool = {
  id: string;
  type: string;
  name?: string;
  vectorStoreId?: string;
  label?: string;
  url?: string;
  authorization?: string;
  authorizationConfigured?: boolean;
  allowedTools?: string[];
  description?: string;
  parameters?: string;
  webhookUrl?: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  provider: Provider;
  model: string;
  instructions: string;
  variables: Array<{ id: string; key: string; value: string }>;
  tools: Tool[];
  synthesisEnabled: boolean;
  voice: string;
  role: string;
  speed: number;
  recognitionLanguage: string;
  vadEnabled: boolean;
  vadThreshold: number;
  silenceDurationMs: number;
  speaksFirst: boolean;
  firstMessage: string;
  maxCallSeconds: number;
  ambientSound: string;
  ambientVolume: number;
  outputGain: number;
  guardrails: string;
  pronunciations: Array<{ id: string; from: string; to: string }>;
  keyterms: string;
  followUpSeconds: number;
  followUpMessage: string;
  allowInterruptions: boolean;
  shareCallerNumber: boolean;
  timezone: string;
  avatar: string;
  notifyEmail: string;
  knowledge: Array<{ id: string; name: string; text: string }>;
  publishedAt?: string;
  live?: boolean;
  unpublished?: boolean;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PhoneConnection = {
  id: string;
  name: string;
  providerPreset: string;
  dialFormat: string;
  fromUser: string;
  enabled: boolean;
  number: string;
  agentId: string;
  registrar: string;
  proxy: string;
  username: string;
  password: string;
  passwordConfigured?: boolean;
  transport: "udp" | "tcp";
  operatorExtension: string;
  mode: "register" | "direct";
  allowedAddresses: string[];
};

export type VoiceSettings = {
  yandexFolderId: string;
  yandexApiKey: string;
  yandexApiKeyConfigured?: boolean;
  gatewayPublicUrl: string;
  openaiApiKey: string;
  openaiApiKeyConfigured?: boolean;
  openaiProjectId: string;
  xaiApiKey: string;
  xaiApiKeyConfigured?: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpPasswordConfigured?: boolean;
  smtpFrom: string;
  bitrixWebhookUrl: string;
  bitrixWebhookConfigured?: boolean;
  amoBaseUrl: string;
  amoAccessToken: string;
  amoAccessTokenConfigured?: boolean;
  sheetsSpreadsheetId: string;
  sheetsSheetName: string;
  sheetsServiceAccountKey: string;
  sheetsServiceAccountConfigured?: boolean;
  // Приходят с backend только для чтения: общий ключ и секрет ссылок живут
  // в окружении сервера, из панели их не задать.
  sheetsSharedKeyAvailable?: boolean;
  recordingLinksAvailable?: boolean;
  attachRecording: boolean;
  phoneConnections: PhoneConnection[];
};

export type IntegrationStatus = { status: "sent" | "failed" | "skipped"; detail: string; entityId: string; at: string };

export type Contact = { id: string; phone: string; name: string; language: string; status: string; lastMessage: string; updatedAt: string; unread: number };
export type Message = { id: string; direction: "inbound" | "outbound"; text: string; createdAt: string };
export type CallOutcome = { resolved: boolean; summary: string; confirmation: string; operator: string; nextStep: string };
export type CallRecord = {
  id: string;
  agentId?: string;
  direction: "inbound" | "outbound";
  phone: string;
  agentName: string;
  status: string;
  error: string;
  outcome: CallOutcome | null;
  toolCalls: number;
  recordedSeconds: number;
  createdAt: string;
  endedAt: string;
  variables: Record<string, string>;
  integrations?: Record<string, IntegrationStatus>;
};

export type CampaignRecipient = {
  id: string;
  position: number;
  phone: string;
  name: string;
  variables: Record<string, string>;
  status: "pending" | "dispatching" | "dialing" | "completed" | "failed" | "skipped";
  callId: string | null;
  callStatus: string | null;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type CallCampaign = {
  id: string;
  name: string;
  agentId: string;
  connectionId: string;
  purposeTemplate: string;
  status: "draft" | "running" | "paused" | "completed";
  intervalSeconds: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts: { total: number; pending: number; active: number; completed: number; failed: number };
  recipients?: CampaignRecipient[];
};
