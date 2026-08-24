import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { currentTenantId, DEFAULT_TENANT } from "./tenant-context.ts";

export const realtimeModelCatalog = [
  { id: "speech-realtime-260528", provider: "yandex", label: "Speech Realtime 260528", note: "Основная модель Yandex" },
  { id: "speech-realtime-250923", provider: "yandex", label: "Speech Realtime 250923", note: "Предыдущая стабильная версия" },
  { id: "speech-realtime-deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash Realtime", note: "Экспериментальная, может отвечать медленнее" },
  { id: "grok-voice-think-fast-2.0", provider: "xai", label: "Grok Voice Think Fast 2.0", note: "Единственная realtime-модель xAI, отвечает за 0,7 с" },
  { id: "gpt-realtime-2.1", provider: "openai", label: "GPT Realtime 2.1", note: "Флагманская модель OpenAI" },
  { id: "gpt-realtime-2.1-mini", provider: "openai", label: "GPT Realtime 2.1 mini", note: "Быстрее и экономичнее" },
  { id: "gpt-realtime-2", provider: "openai", label: "GPT Realtime 2", note: "Предыдущее поколение" },
  { id: "gpt-realtime-1.5", provider: "openai", label: "GPT Realtime 1.5", note: "Совместимая стабильная версия" },
] as const;

export const realtimeModels = realtimeModelCatalog.map((model) => model.id);
export const aiProviders = ["yandex", "deepseek", "openai", "xai"] as const;
export type AiProvider = (typeof aiProviders)[number];
export const providerLabels: Record<AiProvider, string> = { yandex: "Yandex AI Studio", deepseek: "DeepSeek", openai: "OpenAI", xai: "xAI Grok Voice" };

export function providerTransport(provider: AiProvider) {
  if (provider === "openai") return "openai";
  if (provider === "xai") return "xai";
  return "yandex";
}
export const ambientSounds = ["none", "office", "cafe", "street"] as const;
export type AmbientSound = (typeof ambientSounds)[number];
export type RealtimeModel = (typeof realtimeModelCatalog)[number]["id"];
export type VoiceTool =
  | { id: string; type: "ascn"; name: "contact_context" | "update_contact" | "move_pipeline" | "remember_note" | "transfer_call" | "end_call" | "search_knowledge" }
  | { id: string; type: "dtmf" }
  | { id: string; type: "web_search" }
  | { id: string; type: "file_search"; vectorStoreId: string }
  | { id: string; type: "mcp"; label: string; url: string; authorization: string; requireApproval: "never" | "always" }
  | { id: string; type: "function"; name: string; description: string; parameters: string; webhookUrl: string; authorization: string };

// Снимок черновика: всё, что влияет на звонок. Имя, аватар и получатель писем
// в снимок не входят — их правка не меняет поведение агента в трубке.
export type PublishedAgent = Omit<VoiceAgent, "id" | "name" | "description" | "avatar" | "notifyEmail" | "published" | "publishedAt" | "active" | "createdAt" | "updatedAt">;

export type VoiceAgent = {
  id: string;
  name: string;
  description: string;
  provider: AiProvider;
  model: RealtimeModel;
  instructions: string;
  variables: Array<{ id: string; key: string; value: string }>;
  tools: VoiceTool[];
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
  ambientSound: AmbientSound;
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
  published: PublishedAgent | null;
  publishedAt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export const dialFormats = ["e164", "ru7", "ru8", "raw"] as const;
export type DialFormat = (typeof dialFormats)[number];

export type PhoneConnection = {
  id: string;
  name: string;
  providerPreset: string;
  dialFormat: DialFormat;
  fromUser: "number" | "login";
  enabled: boolean;
  number: string;
  agentId: string;
  registrar: string;
  proxy: string;
  username: string;
  password: string;
  transport: "udp" | "tcp";
  operatorExtension: string;
  mode: "register" | "direct";
  allowedAddresses: string[];
};

export type VoiceConnectionSettings = {
  yandexFolderId: string;
  yandexApiKey: string;
  openaiApiKey: string;
  openaiProjectId: string;
  xaiApiKey: string;
  gatewayPublicUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  phoneConnections: PhoneConnection[];
};

export type SafePhoneConnection = Omit<PhoneConnection, "password"> & { passwordConfigured: boolean; password?: string };
export type SafeVoiceSettings = Omit<VoiceConnectionSettings, "yandexApiKey" | "openaiApiKey" | "xaiApiKey" | "smtpPassword" | "phoneConnections"> & {
  yandexApiKeyConfigured: boolean;
  openaiApiKeyConfigured: boolean;
  xaiApiKeyConfigured: boolean;
  smtpPasswordConfigured: boolean;
  yandexApiKey?: string;
  openaiApiKey?: string;
  xaiApiKey?: string;
  smtpPassword?: string;
  phoneConnections: SafePhoneConnection[];
};

export type SafeVoiceTool = Omit<Extract<VoiceTool, { type: "mcp" }>, "authorization"> & { authorizationConfigured?: boolean }
  | Omit<Extract<VoiceTool, { type: "function" }>, "authorization"> & { authorizationConfigured?: boolean }
  | Exclude<VoiceTool, { type: "mcp" | "function" }>;

export type SafeVoiceAgent = Omit<VoiceAgent, "tools"> & { tools: SafeVoiceTool[]; live: boolean; unpublished: boolean };

const rootDirectory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".data");
// Тенант default живёт по прежним путям: работающая установка ничего не мигрирует.
// Остальные тенанты — по каталогу на пользователя.
function tenantDirectory(tenantId: string) {
  if (tenantId === DEFAULT_TENANT) return rootDirectory;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("Некорректный идентификатор тенанта");
  return path.join(rootDirectory, "tenants", tenantId);
}
function voicePathFor(tenantId: string) { return path.join(tenantDirectory(tenantId), "voice-agents.json"); }
// Конфиг Asterisk общий на все тенанты: телефония одна.
const asteriskDirectory = path.join(rootDirectory, "asterisk");
const asteriskProviderPath = path.join(asteriskDirectory, "pjsip-provider.conf");

// Очередь изменений — своя на тенанта, иначе записи разных людей толкались бы.
const queues = new Map<string, Promise<unknown>>();
function queueFor(tenantId: string) { return queues.get(tenantId) || Promise.resolve(); }

const defaultSettings: VoiceConnectionSettings = {
  yandexFolderId: "",
  yandexApiKey: "",
  openaiApiKey: "",
  openaiProjectId: "",
  xaiApiKey: "",
  gatewayPublicUrl: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  smtpFrom: "",
  phoneConnections: [],
};

type VoiceStore = { agents: VoiceAgent[]; settings: VoiceConnectionSettings };

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanSecret(value: unknown, max = 1000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function cleanId(value: unknown) {
  const id = cleanText(value, 100);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : crypto.randomUUID();
}

function normalizeTool(value: unknown, existing?: VoiceTool): VoiceTool | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = cleanId(source.id);
  if (source.type === "ascn") {
    const allowed = new Set(["contact_context", "update_contact", "move_pipeline", "remember_note", "transfer_call", "end_call", "search_knowledge"]);
    const name = cleanText(source.name, 40);
    return allowed.has(name) ? { id, type: "ascn", name: name as Extract<VoiceTool, { type: "ascn" }>["name"] } : null;
  }
  if (source.type === "dtmf") return { id, type: "dtmf" };
  if (source.type === "web_search") return { id, type: "web_search" };
  if (source.type === "file_search") {
    const vectorStoreId = cleanText(source.vectorStoreId, 200);
    return vectorStoreId ? { id, type: "file_search", vectorStoreId } : null;
  }
  if (source.type === "mcp") {
    const previous = existing?.type === "mcp" ? existing : undefined;
    const url = cleanText(source.url, 1000);
    if (!/^https:\/\//i.test(url)) return null;
    return {
      id,
      type: "mcp",
      label: cleanText(source.label, 64) || "mcp",
      url,
      authorization: cleanSecret(source.authorization) || previous?.authorization || "",
      requireApproval: source.requireApproval === "always" ? "always" : "never",
    };
  }
  if (source.type === "function") {
    const previous = existing?.type === "function" ? existing : undefined;
    const name = cleanText(source.name, 64);
    const webhookUrl = cleanText(source.webhookUrl, 1000);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !/^https:\/\//i.test(webhookUrl)) return null;
    const parameters = cleanText(source.parameters, 12000) || "{}";
    try { JSON.parse(parameters); } catch { return null; }
    return {
      id,
      type: "function",
      name,
      description: cleanText(source.description, 500),
      parameters,
      webhookUrl,
      authorization: cleanSecret(source.authorization) || previous?.authorization || "",
    };
  }
  return null;
}

function normalizeAgent(value: unknown, existing?: VoiceAgent): VoiceAgent {
  if (!value || typeof value !== "object") throw new Error("Передайте настройки голосового агента");
  const source = value as Record<string, unknown>;
  const name = cleanText(source.name, 80);
  const instructions = typeof source.instructions === "string" ? source.instructions.trim().slice(0, 30000) : "";
  if (!name) throw new Error("Укажите имя голосового агента");
  if (!instructions) throw new Error("Добавьте системный промпт");
  const modelInfo = realtimeModelCatalog.find((item) => item.id === source.model);
  const provider: AiProvider = modelInfo?.provider || ((aiProviders as readonly string[]).includes(String(source.provider)) ? source.provider as AiProvider : "yandex");
  const providerModels = realtimeModelCatalog.filter((item) => item.provider === provider);
  const model = (modelInfo?.provider === provider ? modelInfo.id : providerModels[0].id) as RealtimeModel;
  const variableValues = Array.isArray(source.variables) ? source.variables : [];
  const variables = variableValues.slice(0, 30).map((item) => {
    const variable = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const key = cleanText(variable.key, 64).replace(/[^a-zA-Z0-9_]/g, "_");
    return { id: cleanId(variable.id), key, value: cleanText(variable.value, 1000) };
  }).filter((item) => item.key);
  if (new Set(variables.map((item) => item.key)).size !== variables.length) throw new Error("Названия переменных не должны повторяться");
  const previousTools = new Map((existing?.tools || []).map((tool) => [tool.id, tool]));
  const tools = (Array.isArray(source.tools) ? source.tools : []).map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return normalizeTool(item, previousTools.get(String(raw.id)));
  }).filter((item): item is VoiceTool => Boolean(item)).slice(0, 8);
  const now = new Date().toISOString();
  return {
    id: existing?.id || cleanId(source.id),
    name,
    description: cleanText(source.description, 500),
    provider,
    model,
    instructions,
    variables,
    tools,
    synthesisEnabled: source.synthesisEnabled !== false,
    voice: cleanText(source.voice, 80) || (provider === "openai" ? "marin" : "filipp"),
    role: cleanText(source.role, 40),
    speed: Math.min(3, Math.max(0.1, Number(source.speed) || 1)),
    recognitionLanguage: cleanText(source.recognitionLanguage, 20) || "auto",
    vadEnabled: source.vadEnabled !== false,
    vadThreshold: Math.min(1, Math.max(0, Number(source.vadThreshold) || 0.5)),
    silenceDurationMs: Math.min(5000, Math.max(100, Math.round(Number(source.silenceDurationMs) || 800))),
    speaksFirst: source.speaksFirst === true,
    firstMessage: cleanText(source.firstMessage, 1000),
    maxCallSeconds: Math.min(7200, Math.max(0, Math.round(Number(source.maxCallSeconds) || 0))),
    ambientSound: (ambientSounds as readonly string[]).includes(cleanText(source.ambientSound, 20)) ? cleanText(source.ambientSound, 20) as AmbientSound : "none",
    ambientVolume: Math.min(1, Math.max(0, Number.isFinite(Number(source.ambientVolume)) ? Number(source.ambientVolume) : 0.3)),
    outputGain: Math.min(4, Math.max(1, Number.isFinite(Number(source.outputGain)) ? Number(source.outputGain) : 1.6)),
    guardrails: cleanText(source.guardrails, 2000),
    pronunciations: (Array.isArray(source.pronunciations) ? source.pronunciations : []).map((item) => {
      const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { id: cleanId(raw.id), from: cleanText(raw.from, 80), to: cleanText(raw.to, 80) };
    }).filter((item) => item.from && item.to).slice(0, 40),
    keyterms: cleanText(source.keyterms, 600),
    followUpSeconds: Math.min(120, Math.max(0, Math.round(Number(source.followUpSeconds) || 0))),
    followUpMessage: cleanText(source.followUpMessage, 400),
    allowInterruptions: source.allowInterruptions !== false,
    shareCallerNumber: source.shareCallerNumber !== false,
    timezone: safeTimezone(cleanText(source.timezone, 60)),
    avatar: safeAvatar(source.avatar),
    notifyEmail: cleanText(source.notifyEmail, 200).replace(/[\s<>]/g, ""),
    knowledge: (Array.isArray(source.knowledge) ? source.knowledge : []).map((item) => {
      const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { id: cleanId(raw.id), name: cleanText(raw.name, 120), text: typeof raw.text === "string" ? raw.text.slice(0, 200000) : "" };
    }).filter((item) => item.name && item.text).slice(0, 20),
    published: existing?.published || null,
    publishedAt: existing?.publishedAt || "",
    active: source.active !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

// Октеты проверяем по значению, а не по числу цифр: 999.999.999.999 подходит
// под «три цифры через точку», но Asterisk на таком адресе не стартует.
function isMatchableAddress(value: string) {
  const [address, prefix, ...extra] = value.split("/");
  if (extra.length) return false;
  if (prefix !== undefined && !(/^[0-9]{1,2}$/.test(prefix) && Number(prefix) <= 32)) return false;
  const octets = address.split(".");
  if (octets.length === 4 && octets.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)) return true;
  return prefix === undefined && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(address) && /[a-z]/i.test(address);
}

function normalizePhoneConnection(value: unknown, existing?: PhoneConnection): PhoneConnection {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const safe = (field: string, max: number) => cleanText(source[field], max).replace(/[\r\n[\]]/g, "");
  return {
    id: existing?.id || cleanId(source.id),
    name: safe("name", 80) || "Телефонный номер",
    providerPreset: safe("providerPreset", 40) || "custom",
    dialFormat: (dialFormats as readonly string[]).includes(safe("dialFormat", 10)) ? safe("dialFormat", 10) as DialFormat : "e164",
    fromUser: source.fromUser === "login" ? "login" : "number",
    enabled: source.enabled !== false,
    number: safe("number", 40),
    agentId: safe("agentId", 100),
    registrar: safe("registrar", 255),
    proxy: safe("proxy", 255),
    username: safe("username", 255),
    password: cleanSecret(source.password, 255).replace(/[\r\n[\]]/g, "") || existing?.password || "",
    transport: source.transport === "tcp" ? "tcp" : "udp",
    operatorExtension: safe("operatorExtension", 100),
    mode: source.mode === "direct" ? "direct" : "register",
    // Прямой SIP пускает звонки по адресу отправителя, поэтому список должен
    // содержать только корректные адреса или подсети — иначе Asterisk не поднимется.
    allowedAddresses: (Array.isArray(source.allowedAddresses) ? source.allowedAddresses : [])
      .map((item) => String(item || "").trim())
      .filter(isMatchableAddress)
      .slice(0, 20),
  };
}

function normalizeSettings(value: unknown, existing: VoiceConnectionSettings) {
  if (!value || typeof value !== "object") throw new Error("Передайте настройки подключения");
  const source = value as Record<string, unknown>;
  const gatewayPublicUrl = cleanText(source.gatewayPublicUrl, 1000);
  if (gatewayPublicUrl && !/^wss?:\/\//i.test(gatewayPublicUrl)) throw new Error("Адрес voice gateway должен начинаться с ws:// или wss://");
  const safe = (field: string, max: number) => cleanText(source[field], max).replace(/[\r\n[\]]/g, "");
  const previousConnections = new Map(existing.phoneConnections.map((connection) => [connection.id, connection]));
  const phoneConnections = (Array.isArray(source.phoneConnections) ? source.phoneConnections : []).slice(0, 30).map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return normalizePhoneConnection(item, previousConnections.get(String(raw.id)));
  });
  return {
    yandexFolderId: safe("yandexFolderId", 100),
    yandexApiKey: cleanSecret(source.yandexApiKey) || existing.yandexApiKey,
    openaiApiKey: cleanSecret(source.openaiApiKey) || existing.openaiApiKey,
    openaiProjectId: safe("openaiProjectId", 200),
    xaiApiKey: cleanSecret(source.xaiApiKey) || existing.xaiApiKey,
    gatewayPublicUrl,
    smtpHost: safe("smtpHost", 200),
    smtpPort: Math.min(65535, Math.max(1, Number(source.smtpPort) || 587)),
    smtpUser: safe("smtpUser", 200),
    smtpPassword: cleanSecret(source.smtpPassword) || existing.smtpPassword,
    smtpFrom: safe("smtpFrom", 200),
    phoneConnections,
  };
}

function migrateSettings(value: unknown): VoiceConnectionSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const base: VoiceConnectionSettings = {
    ...defaultSettings,
    yandexFolderId: typeof source.yandexFolderId === "string" ? source.yandexFolderId : "",
    yandexApiKey: typeof source.yandexApiKey === "string" ? source.yandexApiKey : "",
    openaiApiKey: typeof source.openaiApiKey === "string" ? source.openaiApiKey : "",
    openaiProjectId: typeof source.openaiProjectId === "string" ? source.openaiProjectId : "",
    xaiApiKey: typeof source.xaiApiKey === "string" ? source.xaiApiKey : "",
    gatewayPublicUrl: typeof source.gatewayPublicUrl === "string" ? source.gatewayPublicUrl : "",
    smtpHost: typeof source.smtpHost === "string" ? source.smtpHost : "",
    smtpPort: Math.min(65535, Math.max(1, Number(source.smtpPort) || 587)),
    smtpUser: typeof source.smtpUser === "string" ? source.smtpUser : "",
    smtpPassword: typeof source.smtpPassword === "string" ? source.smtpPassword : "",
    smtpFrom: typeof source.smtpFrom === "string" ? source.smtpFrom : "",
    phoneConnections: Array.isArray(source.phoneConnections) ? source.phoneConnections.map((item) => normalizePhoneConnection(item)) : [],
  };
  if (!base.phoneConnections.length && (source.sipRegistrar || source.sipNumber || source.sipUsername)) {
    base.phoneConnections = [normalizePhoneConnection({
      id: "legacy-phone",
      name: "Основной номер",
      providerPreset: "custom",
      enabled: source.sipEnabled === true,
      number: source.sipNumber,
      registrar: source.sipRegistrar,
      proxy: source.sipProxy,
      username: source.sipUsername,
      password: source.sipPassword,
      transport: source.sipTransport,
      operatorExtension: source.operatorExtension,
    })];
  }
  return base;
}

// Агенты, сохранённые до появления новых полей, читаются как есть — промпт
// обращается к ним напрямую, поэтому пустые значения подставляем при чтении.
function migrateAgent(value: Partial<VoiceAgent>): VoiceAgent {
  const modelInfo = realtimeModelCatalog.find((item) => item.id === value.model);
  return {
    ...value,
    provider: modelInfo?.provider || value.provider || "yandex",
    guardrails: typeof value.guardrails === "string" ? value.guardrails : "",
    pronunciations: Array.isArray(value.pronunciations) ? value.pronunciations : [],
    keyterms: typeof value.keyterms === "string" ? value.keyterms : "",
    followUpSeconds: Number(value.followUpSeconds) || 0,
    followUpMessage: typeof value.followUpMessage === "string" ? value.followUpMessage : "",
    allowInterruptions: value.allowInterruptions !== false,
    shareCallerNumber: value.shareCallerNumber !== false,
    timezone: safeTimezone(typeof value.timezone === "string" ? value.timezone : ""),
    avatar: safeAvatar(value.avatar),
    notifyEmail: typeof value.notifyEmail === "string" ? value.notifyEmail : "",
    knowledge: Array.isArray(value.knowledge) ? value.knowledge : [],
    published: value.published || null,
    publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : "",
  } as VoiceAgent;
}

async function readStore(tenantId = currentTenantId()): Promise<VoiceStore> {
  try {
    const parsed = JSON.parse(await readFile(voicePathFor(tenantId), "utf8")) as Partial<VoiceStore>;
    const agents = (Array.isArray(parsed.agents) ? parsed.agents : []).map(migrateAgent);
    return { agents, settings: migrateSettings(parsed.settings) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { agents: [], settings: { ...defaultSettings } };
  }
}

async function writeStore(store: VoiceStore) {
  const tenantId = currentTenantId();
  await mkdir(tenantDirectory(tenantId), { recursive: true });
  const target = voicePathFor(tenantId);
  const temporaryPath = `${target}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, target);
}

function mutate<T>(operation: (store: VoiceStore) => T | Promise<T>) {
  const tenantId = currentTenantId();
  const run = queueFor(tenantId).catch(() => undefined).then(async () => {
    const store = await readStore(tenantId);
    const result = await operation(store);
    await writeStore(store);
    return result;
  });
  queues.set(tenantId, run.then(() => undefined, () => undefined));
  return run;
}

export function toSafeAgent(agent: VoiceAgent): SafeVoiceAgent {
  return {
    ...agent,
    live: Boolean(agent.published),
    unpublished: hasUnpublishedChanges(agent),
    tools: agent.tools.map((tool) => {
      if (tool.type === "mcp") {
        return { id: tool.id, type: tool.type, label: tool.label, url: tool.url, requireApproval: tool.requireApproval, authorizationConfigured: Boolean(tool.authorization) };
      }
      if (tool.type === "function") {
        return { id: tool.id, type: tool.type, name: tool.name, description: tool.description, parameters: tool.parameters, webhookUrl: tool.webhookUrl, authorizationConfigured: Boolean(tool.authorization) };
      }
      return tool;
    }),
  };
}

export async function listVoiceAgents() {
  await queueFor(currentTenantId());
  return (await readStore()).agents.map(toSafeAgent);
}

export async function getVoiceAgent(id?: string) {
  await queueFor(currentTenantId());
  const agents = (await readStore()).agents;
  return (id ? agents.find((agent) => agent.id === id) : agents.find((agent) => agent.active)) || null;
}

export function saveVoiceAgent(value: unknown, id?: string) {
  return mutate((store) => {
    const existing = id ? store.agents.find((agent) => agent.id === id) : undefined;
    if (id && !existing) throw new Error("Голосовой агент не найден");
    const agent = normalizeAgent(value, existing);
    if (existing) Object.assign(existing, agent);
    else store.agents.push(agent);
    return toSafeAgent(agent);
  });
}

export function deleteVoiceAgent(id: string) {
  return mutate((store) => {
    const index = store.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return false;
    const [removed] = store.agents.splice(index, 1);
    store.settings.phoneConnections.forEach((connection) => { if (connection.agentId === removed.id) connection.agentId = ""; });
    return true;
  });
}

export function getVoiceSettings(safe: false): Promise<VoiceConnectionSettings>;
export function getVoiceSettings(safe?: true): Promise<SafeVoiceSettings>;
export async function getVoiceSettings(safe = true) {
  await queueFor(currentTenantId());
  const settings = (await readStore()).settings;
  if (!safe) return settings;
  return getVoiceSettingsFromValue(settings);
}

function endpointId(connection: PhoneConnection, tenantId = currentTenantId()) {
  const base = `ascn-${connection.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)}`;
  return tenantId === DEFAULT_TENANT ? base : `t${tenantId.replace(/[^a-z0-9]/gi, "").slice(0, 8)}-${base}`;
}

function renderAsteriskProviders(settings: VoiceConnectionSettings, tenantId = currentTenantId()) {
  const ready = settings.phoneConnections.filter((item) => item.enabled && (item.mode === "direct" ? item.allowedAddresses.length > 0 : item.registrar && item.username && item.password));
  if (!ready.length) return "; SIP-транки не настроены в ASCN\n";
  return ready.map((connection) => {
    const section = endpointId(connection, tenantId);
    const transport = connection.transport === "tcp" ? "transport-tcp" : "transport-udp";
    const proxy = connection.proxy ? `outbound_proxy=sip:${connection.proxy}\\;lr\n` : "";
    const match = connection.registrar.replace(/^sips?:\/\//i, "").split(":")[0];
    const fromUser = connection.fromUser === "login" ? connection.username : connection.number || connection.username;
    // Прямой SIP: оператор сам звонит на наш адрес, регистрация и пароль не нужны.
    // Звонок опознаётся по адресу отправителя через identify.
    if (connection.mode === "direct") {
      return `; ${connection.name} · ${connection.number} · прямой SIP\n[${section}-endpoint]\ntype=endpoint\ntransport=${transport}\ncontext=from-provider\ndisallow=all\nallow=alaw,ulaw\ndirect_media=no\nrtp_symmetric=yes\nforce_rport=yes\nrewrite_contact=yes\nfrom_user=${fromUser}\nfrom_domain=${connection.registrar.replace(/^sips?:\/\//i, "").split(":")[0] || "ascn"}\n\n[${section}-identify]\ntype=identify\nendpoint=${section}-endpoint\n${connection.allowedAddresses.map((address) => `match=${address}`).join("\n")}\n`;
    }
    return `; ${connection.name} · ${connection.number}\n[${section}-auth]\ntype=auth\nauth_type=userpass\nusername=${connection.username}\npassword=${connection.password}\n\n[${section}-aor]\ntype=aor\ncontact=sip:${connection.registrar}\nqualify_frequency=60\n\n[${section}-endpoint]\ntype=endpoint\ntransport=${transport}\ncontext=from-provider\ndisallow=all\nallow=alaw,ulaw\ndirect_media=no\nrtp_symmetric=yes\nforce_rport=yes\nrewrite_contact=yes\noutbound_auth=${section}-auth\naors=${section}-aor\nfrom_user=${fromUser}\nfrom_domain=${connection.registrar}\n${proxy}\n[${section}-registration]\ntype=registration\ntransport=${transport}\noutbound_auth=${section}-auth\nserver_uri=sip:${connection.registrar}\nclient_uri=sip:${connection.username}@${connection.registrar}\ncontact_user=${connection.number || connection.username}\nretry_interval=60\nforbidden_retry_interval=300\nexpiration=300\n${proxy}\n[${section}-identify]\ntype=identify\nendpoint=${section}-endpoint\nmatch=${match}\n`;
  }).join("\n");
}

export async function listTenantIds() {
  const ids = [DEFAULT_TENANT];
  try {
    for (const entry of await readdir(path.join(rootDirectory, "tenants"))) {
      if (/^[0-9a-f-]{36}$/i.test(entry)) ids.push(entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return ids;
}

// Телефония одна на всех: конфиг Asterisk собирается из транков каждого тенанта.
// Настройки текущего тенанта приходят из памяти: на диске они ещё старые,
// запись случится после этого рендера.
async function renderAsteriskAll(current: { tenantId: string; settings: VoiceConnectionSettings }) {
  const parts: string[] = [];
  for (const tenantId of await listTenantIds()) {
    const settings = tenantId === current.tenantId
      ? current.settings
      : (await readStore(tenantId).catch(() => null))?.settings;
    if (settings?.phoneConnections.length) parts.push(renderAsteriskProviders(settings, tenantId));
  }
  return parts.join("\n") || "; SIP-транки не настроены в ASCN\n";
}

// Входящий приходит без тенанта — находим владельца номера по DID.
export async function findTenantByDid(did: string) {
  const wanted = normalizeDialedNumber(did || "");
  if (!wanted) return null;
  for (const tenantId of await listTenantIds()) {
    const store = await readStore(tenantId).catch(() => null);
    if (store?.settings.phoneConnections.some((item) => item.enabled && normalizeDialedNumber(item.number) === wanted)) return tenantId;
  }
  return null;
}

export function saveVoiceSettings(value: unknown) {
  return mutate(async (store) => {
    store.settings = normalizeSettings(value, store.settings);
    await mkdir(asteriskDirectory, { recursive: true });
    const temporaryPath = `${asteriskProviderPath}.tmp`;
    await writeFile(temporaryPath, await renderAsteriskAll({ tenantId: currentTenantId(), settings: store.settings }), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, asteriskProviderPath);
    return getVoiceSettingsFromValue(store.settings);
  });
}

function getVoiceSettingsFromValue(settings: VoiceConnectionSettings) {
  return {
    yandexFolderId: settings.yandexFolderId,
    openaiProjectId: settings.openaiProjectId,
    gatewayPublicUrl: settings.gatewayPublicUrl,
    yandexApiKeyConfigured: Boolean(settings.yandexApiKey),
    openaiApiKeyConfigured: Boolean(settings.openaiApiKey),
    xaiApiKeyConfigured: Boolean(settings.xaiApiKey),
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpUser: settings.smtpUser,
    smtpFrom: settings.smtpFrom,
    smtpPasswordConfigured: Boolean(settings.smtpPassword),
    phoneConnections: settings.phoneConnections.map(({ password, ...connection }) => ({ ...connection, passwordConfigured: Boolean(password) })),
  };
}

function normalizeDialedNumber(value: string) {
  return value.replace(/[^0-9]/g, "").replace(/^8(?=\d{10}$)/, "7");
}

// Черновик правится в панели, звонки идут по опубликованному снимку.
// Пустой снимок означает, что агент ещё не публиковался — тогда живёт черновик.
export function liveAgent(agent: VoiceAgent): VoiceAgent {
  return agent.published ? { ...agent, ...agent.published } : agent;
}

export function draftSnapshot(agent: VoiceAgent): PublishedAgent {
  const { id, name, description, avatar, notifyEmail, published, publishedAt, active, createdAt, updatedAt, ...rest } = agent;
  void id; void name; void description; void avatar; void notifyEmail; void published; void publishedAt; void active; void createdAt; void updatedAt;
  return rest;
}

export function hasUnpublishedChanges(agent: VoiceAgent) {
  if (!agent.published) return false;
  return JSON.stringify(draftSnapshot(agent)) !== JSON.stringify(agent.published);
}

export function publishVoiceAgent(id: string) {
  return mutate((store) => {
    const agent = store.agents.find((item) => item.id === id);
    if (!agent) return null;
    agent.published = draftSnapshot(agent);
    agent.publishedAt = new Date().toISOString();
    return { ...agent };
  });
}

export function unpublishVoiceAgent(id: string) {
  return mutate((store) => {
    const agent = store.agents.find((item) => item.id === id);
    if (!agent) return null;
    agent.published = null;
    agent.publishedAt = "";
    return { ...agent };
  });
}

export async function resolveVoiceRoute(did?: string, requestedAgentId?: string) {
  await queueFor(currentTenantId());
  const store = await readStore();
  const normalizedDid = normalizeDialedNumber(did || "");
  const connection = normalizedDid ? store.settings.phoneConnections.find((item) => item.enabled && normalizeDialedNumber(item.number) === normalizedDid) : undefined;
  const agentId = requestedAgentId || connection?.agentId;
  const found = (agentId ? store.agents.find((item) => item.id === agentId) : store.agents.find((item) => item.active)) || null;
  return { agent: found ? liveAgent(found) : null, draft: found, connection: connection || null, settings: store.settings };
}

export function canonicalPhone(value: string) {
  const raw = String(value || "").trim().slice(0, 60);
  if (!raw || /[^0-9+()\s-]/.test(raw)) return raw;
  const digits = raw.replace(/[^0-9]/g, "").replace(/^8(?=\d{10}$)/, "7");
  return digits ? `+${digits}` : raw;
}

export function formatDialNumber(value: string, format: DialFormat) {
  if (format === "raw") return String(value || "").replace(/[^0-9+*#]/g, "").slice(0, 21);
  const digits = String(value || "").replace(/[^0-9]/g, "").replace(/^8(?=\d{10}$)/, "7");
  if (!digits) return "";
  if (format === "ru8") return digits.length === 11 && digits.startsWith("7") ? `8${digits.slice(1)}` : digits;
  if (format === "ru7") return digits;
  return `+${digits}`;
}

export function normalizeDialTarget(value: string) {
  const trimmed = String(value || "").trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  return digits.length >= 3 && digits.length <= 20 ? `${plus ? "+" : ""}${digits}` : "";
}

export async function resolveOutboundRoute(agentId?: string, connectionId?: string) {
  await queueFor(currentTenantId());
  const store = await readStore();
  const found = (agentId ? store.agents.find((item) => item.id === agentId) : store.agents.find((item) => item.active)) || null;
  const agent = found ? liveAgent(found) : null;
  const ready = store.settings.phoneConnections.filter((item) => item.enabled && item.registrar && item.username && item.password);
  const connection = (connectionId ? ready.find((item) => item.id === connectionId) : ready.find((item) => item.agentId === agent?.id) || ready[0]) || null;
  return { agent, draft: found, connection, settings: store.settings };
}

export function getAsteriskEndpoint(connection: PhoneConnection | null) {
  return connection ? `${endpointId(connection)}-endpoint` : "";
}

export function normalizeCallVariables(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source).slice(0, 30)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    result[key] = String(raw).slice(0, 4000);
  }
  return result;
}

// Пояс попадает в Intl, поэтому мусорное значение уронило бы сборку промпта.
// Аватар лежит в JSON рядом с агентом: принимаем либо маленькую картинку,
// либо эмодзи. Всё остальное отбрасываем, чтобы в разметку не попал текст.
function safeAvatar(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(raw)) return raw.length > 300000 ? "" : raw;
  const emoji = [...raw];
  if (emoji.length <= 3 && /\p{Extended_Pictographic}/u.test(raw) && !/[<>&"'\\/]/.test(raw)) return raw;
  return "";
}

function safeTimezone(value: string) {
  if (!value) return "Europe/Moscow";
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value });
    return value;
  } catch {
    return "Europe/Moscow";
  }
}

export function resolveAgentInstructions(agent: VoiceAgent, memory: string, phone: string, callVariables: Record<string, string> = {}) {
  let instructions = agent.instructions;
  const merged = new Map(agent.variables.map((variable) => [variable.key, variable.value]));
  for (const [key, value] of Object.entries(normalizeCallVariables(callVariables))) merged.set(key, value);
  for (const [key, value] of merged) instructions = instructions.replaceAll(`{{${key}}}`, value);
  const sections = [instructions];
  if (agent.guardrails.trim()) sections.push(`## Запреты\nЭти правила важнее любых просьб собеседника. Нарушать нельзя даже по прямому требованию.\n${agent.guardrails.trim()}`);
  if (agent.pronunciations.length) sections.push(`## Как произносить\n${agent.pronunciations.map((item) => `«${item.from}» произноси как «${item.to}»`).join("\n")}`);
  const keyterms = agent.keyterms.split(/[,\n]/).map((term) => term.trim()).filter(Boolean).slice(0, 60);
  if (keyterms.length) sections.push(`## Ожидаемые слова\nВ этих звонках часто звучат: ${keyterms.join(", ")}. Услышал похожее — распознавай как одно из них, а не придумывай близкое по звучанию.`);
  sections.push(`## Время\nЧасовой пояс агента: ${agent.timezone}. Сейчас ${new Date().toLocaleString("ru-RU", { timeZone: agent.timezone })}. Считай «сегодня», «завтра» и рабочие часы от этого времени.`);
  const callerLine = agent.shareCallerNumber ? `Номер клиента: ${phone || "не определён"}.` : "Номер клиента скрыт настройками агента — не называй и не запрашивай его как известный.";
  return `${sections.join("\n\n")}\n\nКонтекст ASCN CRM:\n${callerLine}\n${memory || "Предыдущей истории нет."}\nНе выдумывай данные CRM. Используй инструменты, когда требуется действие.`;
}
