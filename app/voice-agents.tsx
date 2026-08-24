"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowLeft, ArrowUp, AudioLines, BookOpen, Bot, Copy, Search, Briefcase, CalendarDays, CircleStop, Code2, ExternalLink, Headphones, Mail, Mic, Phone, Plus, Save, Settings2, ShieldAlert, Sparkles, Trash2, TrendingUp, Upload, UserCheck, Wrench, X, type LucideIcon } from "lucide-react";

type Provider = "yandex" | "deepseek" | "openai" | "xai";
type Transport = "yandex" | "openai" | "xai";
function transportOf(provider: Provider): Transport { return provider === "openai" ? "openai" : provider === "xai" ? "xai" : "yandex"; }
type Tool = { id: string; type: string; name?: string; vectorStoreId?: string; label?: string; url?: string; authorization?: string; authorizationConfigured?: boolean; requireApproval?: string; description?: string; parameters?: string; webhookUrl?: string };
type Agent = {
  id: string; name: string; description: string; provider: Provider; model: string; instructions: string;
  variables: Array<{ id: string; key: string; value: string }>; tools: Tool[];
  synthesisEnabled: boolean; voice: string; role: string; speed: number; recognitionLanguage: string;
  vadEnabled: boolean; vadThreshold: number; silenceDurationMs: number; speaksFirst: boolean; firstMessage: string;
  maxCallSeconds: number; ambientSound: string; ambientVolume: number; outputGain: number;
  guardrails: string; pronunciations: Array<{ id: string; from: string; to: string }>; keyterms: string;
  followUpSeconds: number; followUpMessage: string; allowInterruptions: boolean; shareCallerNumber: boolean; timezone: string;
  avatar: string; notifyEmail: string; knowledge: Array<{ id: string; name: string; text: string }>;
  publishedAt?: string; live?: boolean; unpublished?: boolean;
  active: boolean; createdAt?: string; updatedAt?: string;
};
type PhoneConnection = {
  id: string; name: string; providerPreset: string; dialFormat: string; fromUser: string; enabled: boolean; number: string; agentId: string;
  registrar: string; proxy: string; username: string; password: string; passwordConfigured?: boolean;
  transport: "udp" | "tcp"; operatorExtension: string;
  mode: "register" | "direct"; allowedAddresses: string[];
};
type Settings = {
  yandexFolderId: string; yandexApiKey: string; yandexApiKeyConfigured?: boolean; gatewayPublicUrl: string;
  openaiApiKey: string; openaiApiKeyConfigured?: boolean; openaiProjectId: string;
  xaiApiKey: string; xaiApiKeyConfigured?: boolean;
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPassword: string; smtpPasswordConfigured?: boolean; smtpFrom: string;
  phoneConnections: PhoneConnection[];
};

const templates = {
  "Оператор поддержки": "Ты — голосовой оператор службы поддержки сервиса {{service_name}}.\n\nТвоя задача — принять обращение клиента, уточнить детали и помочь решить вопрос. Говори коротко, естественно и вежливо. Не выдумывай факты. Если вопрос требует человека — используй перевод звонка.",
  "Оператор продаж": "Ты — голосовой менеджер по продажам компании {{company_name}}. Выясни задачу клиента, квалифицируй потребность и предложи подходящий следующий шаг. Сохраняй важные факты в CRM и не дави на клиента.",
  "Заказ в ресторане": "Ты принимаешь заказы для ресторана {{service_name}}. Уточни блюда, количество, адрес или время самовывоза, имя и телефон. Перед подтверждением кратко повтори весь заказ.",
  "Вызов мастера": "Ты — диспетчер сервиса {{service_name}}. Уточни вид неисправности, адрес, удобное время и контактное имя. Сохрани данные клиента и договорённости в CRM.",
  "Личный ассистент (IVR)": "Ты — голосовой ассистент {{owner_name}}. Ты звонишь по его поручению и доводишь задачу до результата за один звонок.\n\n## Робот или человек\nБольшинство деловых звонков начинается с автоответчика или тонального меню. Это не человек.\n- Никогда не приветствуй робота и не рассказывай автоответчику цель звонка.\n- Услышал меню — используй тональный набор и произнеси только короткое ключевое слово или цифру, которая ведёт к живому сотруднику. Ничего больше.\n- Продолжай пробиваться словами «оператор», «специалист», «живой сотрудник», пока не ответит человек.\n- Только когда точно говоришь с человеком — представься и переходи к делу.\n\n## Цель звонка\n{{caller_purpose}}\n\nЭто ориентир, а не текст для зачитывания. Разбивай на короткие естественные реплики и никогда не выдавай всё сразу.\n\n## Как говорить\n- Реплики короткие, одна-две фразы, потом слушай.\n- Используй «эм», «ну», «так», «понятно», «ага» — говори как человек, а не как робот.\n- Не выдавай лишнюю информацию, пока не спросили.\n- Не принимай мягкий отказ: уточни факты, попроси старшего сотрудника, добейся цели.\n- Перед завершением получи номер заявки или подтверждения и имя сотрудника.\n- Если нужно решение владельца или подтверждение личности, которое ты дать не можешь — переводи звонок.",
};
const starters: Array<{ label: string; icon: LucideIcon; tone: string; apply: (base: Agent) => Agent }> = [
  {
    label: "Оператор поддержки", icon: Headphones, tone: "peach",
    apply: (base) => ({ ...base, name: "Оператор поддержки", description: "Отвечает на входящие, решает вопросы клиентов", instructions: templates["Оператор поддержки"], variables: [{ id: id(), key: "service_name", value: "" }], speaksFirst: true, firstMessage: "Здравствуйте! Служба поддержки, слушаю вас." }),
  },
  {
    label: "Менеджер продаж", icon: TrendingUp, tone: "mint",
    apply: (base) => ({ ...base, name: "Менеджер продаж", description: "Выясняет задачу, называет цену, доводит до заказа", instructions: templates["Оператор продаж"], variables: [{ id: id(), key: "company_name", value: "" }], speaksFirst: true, firstMessage: "Здравствуйте! Подскажу по товарам и наличию.", tools: [...base.tools, { id: id(), type: "ascn", name: "move_pipeline" }] }),
  },
  {
    label: "Запись на приём", icon: CalendarDays, tone: "amber",
    apply: (base) => ({ ...base, name: "Запись на приём", description: "Согласует дату и время, подтверждает запись", instructions: templates["Вызов мастера"], variables: [{ id: id(), key: "service_name", value: "" }], speaksFirst: true, firstMessage: "Здравствуйте! Записываю на удобное время." }),
  },
  {
    label: "Личный ассистент", icon: Briefcase, tone: "violet",
    apply: (base) => ({ ...base, name: "Личный ассистент", description: "Звонит по поручению и пробивается через IVR к человеку", instructions: templates["Личный ассистент (IVR)"], variables: [{ id: id(), key: "owner_name", value: "" }, { id: id(), key: "caller_purpose", value: "" }], speaksFirst: false, tools: [...base.tools, { id: id(), type: "dtmf", name: "press_digit" }, { id: id(), type: "ascn", name: "transfer_call" }] }),
  },
  {
    label: "Квалификация лидов", icon: UserCheck, tone: "blue",
    apply: (base) => ({ ...base, name: "Квалификация лидов", description: "Задаёт вопросы, оценивает интерес, двигает по воронке", instructions: templates["Оператор продаж"], variables: [{ id: id(), key: "company_name", value: "" }], speaksFirst: true, firstMessage: "Здравствуйте! Пара вопросов, чтобы подобрать вариант.", tools: [...base.tools, { id: id(), type: "ascn", name: "move_pipeline" }] }),
  },
];

const avatarEmoji = ["🎧", "📞", "🛍️", "👟", "🤖", "💬", "🧾", "📦", "🚚", "🍕", "🔧", "🩺", "💼", "📅", "🏠", "🚗", "✂️", "🎓", "💳", "⚽", "🐾", "🌿", "☕", "🔔"];

// Относительное время: в списке важно «когда трогали», а не точная дата.
function sinceText(iso?: string) {
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

type BuilderMessage = { role: "assistant" | "user"; text: string };

// Помощник задаёт пару вопросов и сам собирает промпт — как «Build a voice agent» у них.
function AgentBuilderDialog({ seed, onCancel, onSkip, onReady, notify }: {
  seed: string; onCancel: () => void; onSkip: () => void; notify: (message: string) => void;
  onReady: (draft: { name: string; description: string; instructions: string; firstMessage: string; keyterms: string; guardrails: string; speaksFirst: boolean }) => void;
}) {
  const [messages, setMessages] = useState<BuilderMessage[]>([{ role: "assistant", text: "Привет! Помогу собрать голосового агента за пару минут. Расскажите своими словами, что он должен делать по телефону — или выберите сценарий кнопкой." }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const seededRef = useRef(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(async (outgoing: string) => {
    const next: BuilderMessage[] = [...messages, { role: "user", text: outgoing }];
    setMessages(next);
    setText("");
    setBusy(true);
    try {
      const response = await fetch("/api/voice/agent-builder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai", messages: next }),
      });
      const result = await response.json();
      if (!response.ok) {
        notify(result.error || "Помощник не ответил");
        setMessages((current) => [...current, { role: "assistant", text: "Не получилось спросить модель. Попробуйте ещё раз или соберите агента вручную кнопкой «Пропустить»." }]);
        return;
      }
      setMessages((current) => [...current, { role: "assistant", text: result.reply }]);
      if (result.ready && result.draft) {
        onReady({ ...result.draft, speaksFirst: Boolean(result.draft.firstMessage) });
        notify("Промпт собран — проверьте и сохраните");
      }
    } finally {
      setBusy(false);
    }
  }, [messages, notify, onReady]);

  useEffect(() => {
    if (seededRef.current || !seed) return;
    seededRef.current = true;
    void send(`Хочу собрать агента: ${seed}.`);
  }, [seed, send]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages]);

  return <div className="dialog-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="dialog builder" role="dialog" aria-modal="true" aria-label="Сборка голосового агента">
      <header>
        <div><h2>Сборка голосового агента</h2><p>Помощник задаст пару вопросов и напишет промпт.</p></div>
        <button type="button" className="pill-button" onClick={onSkip}>Пропустить</button>
      </header>
      <div className="builder-feed" ref={feedRef}>
        {messages.map((message, index) => <p key={`${index}-${message.text.slice(0, 12)}`} className={message.role}>{message.text}</p>)}
        {busy && <p className="assistant thinking"><span /><span /><span /></p>}
      </div>
      <footer className="builder-input">
        <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && text.trim() && !busy) void send(text.trim()); }} placeholder="Опишите, что должен делать агент" aria-label="Сообщение помощнику" />
        <button type="button" className="pill-button solid" disabled={busy || !text.trim()} onClick={() => void send(text.trim())} aria-label="Отправить"><ArrowUp size={16} /></button>
      </footer>
    </div>
  </div>;
}

const tabs = [
  { id: "config", label: "Настройки" },
  { id: "speech", label: "Речь" },
  { id: "deploy", label: "Публикация" },
  { id: "calls", label: "Разговоры" },
  { id: "insights", label: "Показатели" },
];

// Разговоры и показатели конкретного агента — как отдельные вкладки внутри него,
// чтобы не уходить в общий список и не искать там нужные звонки.
function AgentCalls({ agentId }: { agentId: string }) {
  const [calls, setCalls] = useState<Array<{ id: string; phone: string; status: string; direction: string; createdAt: string; endedAt: string; error: string; toolCalls: number; recordedSeconds: number; outcome: { resolved: boolean; summary: string } | null }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch("/api/voice/calls", { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => { if (alive) { setCalls((result.calls || []).filter((call: { agentId: string }) => call.agentId === agentId)); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [agentId]);
  if (loading) return <div className="voice-loading">Загружаем разговоры…</div>;
  if (!agentId) return <p className="knowledge-empty">Сначала сохраните агента.</p>;
  if (!calls.length) return <p className="knowledge-empty">Этот агент ещё не разговаривал. Позвоните на его номер — здесь появятся звонки с итогами.</p>;
  return <section className="call-records">{calls.slice(0, 30).map((call) => {
    const seconds = call.endedAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.createdAt)) / 1000)) : 0;
    return <article key={call.id} className={call.status}>
      <header><span className={`call-status ${call.status}`}>{call.status}</span><strong>{call.phone}</strong><small>{call.direction === "outbound" ? "исходящий" : "входящий"}</small><span className="call-meta">{seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—"}{call.toolCalls ? ` · ${call.toolCalls} инстр.` : ""}</span><time>{new Date(call.createdAt).toLocaleString("ru-RU")}</time></header>
      {/* Субтитров у записи нет: расшифровка разговора лежит рядом отдельным блоком. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      {call.recordedSeconds > 0 && <audio className="call-audio" controls preload="none" src={`/api/voice/recordings/${call.id}`} />}
      {call.error && <p className="call-error">{call.error}</p>}
      {call.outcome && <div className="call-outcome"><strong>{call.outcome.resolved ? "Задача выполнена" : "Задача не закрыта"}</strong>{call.outcome.summary && <p>{call.outcome.summary}</p>}</div>}
    </article>;
  })}</section>;
}

function AgentInsights({ agentId }: { agentId: string }) {
  const [data, setData] = useState<Record<string, number | null> | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/voice/insights?days=30&agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => { if (alive) setData(result); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [agentId]);
  if (!agentId) return <p className="knowledge-empty">Сначала сохраните агента.</p>;
  const tile = (label: string, value: string) => <article key={label}><small>{label}</small><strong>{data ? value : "…"}</strong></article>;
  const seconds = (value: number | null | undefined) => value ? `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}` : "—";
  return <>
    <p className="knowledge-empty">За последние 30 дней, только по этому агенту.</p>
    <section className="insights-grid">{[
      tile("Разговоров", String(data?.conversations ?? 0)),
      tile("Минут всего", String(data?.totalMinutes ?? 0)),
      tile("Стоимость, оценка", `$${Number(data?.costUsd ?? 0).toFixed(2)}`),
      tile("Вызовов инструментов", String(data?.toolCalls ?? 0)),
      tile("Длительность, медиана", seconds(data?.durationP50)),
      tile("До первого звука, медиана", data?.firstAudioP50 ? `${(Number(data.firstAudioP50) / 1000).toFixed(1)} с` : "—"),
      tile("Доля ошибок", data?.errorRate === null || data?.errorRate === undefined ? "—" : `${data.errorRate}%`),
      tile("Доля переводов", data?.transferRate === null || data?.transferRate === undefined ? "—" : `${data.transferRate}%`),
    ]}</section>
  </>;
}

function NewNumberDialog({ agents, taken, serverHost, onCancel, onCreate }: {
  agents: Agent[]; taken: number; serverHost: string;
  onCancel: () => void; onCreate: (connection: PhoneConnection) => void;
}) {
  const [mode, setMode] = useState<"register" | "direct" | "twilio">("register");
  const [twilio, setTwilio] = useState({ accountSid: "", authToken: "", state: "" });

  async function checkTwilio() {
    setTwilio((current) => ({ ...current, state: "Проверяю…" }));
    const response = await fetch("/api/voice/twilio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountSid: twilio.accountSid, authToken: twilio.authToken }) });
    const result = await response.json();
    setTwilio((current) => ({ ...current, state: response.ok ? `Аккаунт «${result.account}» подтверждён` : result.error }));
  }
  const [form, setForm] = useState({ name: "", number: "", providerPreset: "sipnet", registrar: "sipnet.ru", username: "", password: "", address: "", addresses: [] as string[] });
  const patch = (changes: Partial<typeof form>) => setForm((current) => ({ ...current, ...changes }));
  const preset = operatorPresets[form.providerPreset] || operatorPresets.custom;
  const sipUri = `sip:${form.number || "{номер}"}@${serverHost}`;
  const ready = form.number.trim() && (mode === "register"
    ? form.registrar.trim() && form.username.trim() && form.password.trim()
    : form.addresses.length > 0);

  function addAddress(value: string) {
    const address = value.trim();
    if (!address || form.addresses.includes(address)) return;
    patch({ addresses: [...form.addresses, address].slice(0, 20), address: "" });
  }

  function create() {
    onCreate({
      id: id(), name: form.name.trim() || `Номер ${taken + 1}`, providerPreset: form.providerPreset,
      dialFormat: preset.dialFormat, fromUser: preset.fromUser, enabled: true, number: form.number.trim(),
      agentId: agents[0]?.id || "", registrar: form.registrar.trim(), proxy: "",
      username: mode === "register" ? form.username.trim() : "", password: mode === "register" ? form.password : "",
      transport: preset.transport, operatorExtension: "",
      mode: mode === "register" ? "register" : "direct", allowedAddresses: form.addresses,
    });
  }

  return <div className="dialog-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Новый номер">
      <header>
        <div><h2>Новый номер</h2><p>Чтобы на агента можно было позвонить с обычного телефона.</p></div>
        <button type="button" className="dialog-close" aria-label="Закрыть" onClick={onCancel}><X size={17} /></button>
      </header>
      <div className="dialog-note"><Phone size={16} /><div><strong>Номер покупается у оператора связи</strong><p>ASCN не выдаёт номера. Подключите свой: через регистрацию у оператора или прямым SIP.</p></div></div>
      <div className="dialog-tabs">
        <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Регистрация</button>
        <button type="button" className={mode === "direct" ? "active" : ""} onClick={() => setMode("direct")}>Прямой SIP</button>
        <button type="button" className={mode === "twilio" ? "active" : ""} onClick={() => setMode("twilio")}>Twilio</button>
      </div>
      <div className="dialog-body">
        <label className="dialog-field"><span>Название</span><input value={form.name} onChange={(event) => patch({ name: event.target.value })} placeholder="Как называть этот номер" /></label>
        <label className="dialog-field"><span>Номер</span><input value={form.number} onChange={(event) => patch({ number: event.target.value })} placeholder="+74951234567" /></label>
        {mode === "twilio" ? <>
          <label className="dialog-field"><span>Account SID</span><input value={twilio.accountSid} onChange={(event) => setTwilio({ ...twilio, accountSid: event.target.value, state: "" })} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" /></label>
          <label className="dialog-field"><span>Auth Token</span><input type="password" value={twilio.authToken} onChange={(event) => setTwilio({ ...twilio, authToken: event.target.value, state: "" })} placeholder="токен из консоли Twilio" /></label>
          <div className="dialog-field"><div className="dialog-inline"><button type="button" className="ghost-button" disabled={!twilio.accountSid.trim() || !twilio.authToken.trim()} onClick={() => void checkTwilio()}>Проверить ключи</button>{twilio.state && <small>{twilio.state}</small>}</div></div>
          <div className="dialog-field"><span>Куда Twilio направляет звонки</span><div className="dialog-copy"><code>{sipUri}</code><button type="button" aria-label="Скопировать адрес" onClick={() => void navigator.clipboard?.writeText(sipUri)}><Copy size={15} /></button></div><small>Вставьте этот адрес как Origination URI в Elastic SIP Trunk у Twilio и привяжите к нему номер.</small></div>
          <div className="dialog-field" role="group" aria-labelledby="twilio-addresses">
            <span id="twilio-addresses">Разрешённые адреса Twilio</span>
            <div className="dialog-inline"><input value={form.address} onChange={(event) => patch({ address: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addAddress(form.address); } }} placeholder="54.172.60.0/23" /><button type="button" className="ghost-button" disabled={!form.address.trim()} onClick={() => addAddress(form.address)}><Plus size={15} /> Добавить</button></div>
            {form.addresses.length ? <ul className="dialog-chips">{form.addresses.map((address) => <li key={address}><code>{address}</code><button type="button" aria-label={`Убрать ${address}`} onClick={() => patch({ addresses: form.addresses.filter((item) => item !== address) })}><X size={13} /></button></li>)}</ul>
              : <small>Возьмите подсети вашего региона из документации Twilio по Elastic SIP Trunking — я их не подставляю, чтобы не вписать неверные и не сломать приём звонков.</small>}
          </div>
        </> : mode === "register" ? <>
        <label className="dialog-field"><span>Оператор</span><select value={form.providerPreset} onChange={(event) => { const next = event.target.value; patch({ providerPreset: next, registrar: next === "sipnet" ? "sipnet.ru" : "" }); }}>{Object.entries(operatorPresets).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select>{preset.hint && <small>{preset.hint}</small>}</label>
          <label className="dialog-field"><span>SIP-сервер</span><input value={form.registrar} onChange={(event) => patch({ registrar: event.target.value })} placeholder="sipnet.ru" /></label>
          <label className="dialog-field"><span>Логин</span><input value={form.username} onChange={(event) => patch({ username: event.target.value })} placeholder="SIP ID из кабинета оператора" /></label>
          <label className="dialog-field"><span>Пароль</span><input type="password" value={form.password} onChange={(event) => patch({ password: event.target.value })} placeholder="SIP-пароль" /></label>
        </> : <>
          <div className="dialog-field"><span>Куда оператор направляет звонки</span><div className="dialog-copy"><code>{sipUri}</code><button type="button" aria-label="Скопировать адрес" onClick={() => void navigator.clipboard?.writeText(sipUri)}><Copy size={15} /></button></div><small>Впишите этот адрес в переадресацию у оператора. Пароль не нужен — звонок опознаётся по адресу отправителя.</small></div>
          <div className="dialog-field" role="group" aria-labelledby="allowed-addresses">
            <span id="allowed-addresses">Разрешённые адреса</span>
            <div className="dialog-inline"><input value={form.address} onChange={(event) => patch({ address: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addAddress(form.address); } }} placeholder="212.53.40.0/24" /><button type="button" className="ghost-button" disabled={!form.address.trim()} onClick={() => addAddress(form.address)}><Plus size={15} /> Добавить</button></div>
            {form.addresses.length ? <ul className="dialog-chips">{form.addresses.map((address) => <li key={address}><code>{address}</code><button type="button" aria-label={`Убрать ${address}`} onClick={() => patch({ addresses: form.addresses.filter((item) => item !== address) })}><X size={13} /></button></li>)}</ul>
              : <small>Адреса или подсети, с которых оператор отправляет звонки — их даёт сам оператор в настройках переадресации или в поддержке. Со всех остальных адресов агент звонки не примет. Можно указать и домен, например sipnet.ru.</small>}
          </div>
        </>}
      </div>
      <footer>
        <a className="text-button" href="https://www.sipnet.ru/" target="_blank" rel="noreferrer">Как получить номер <ExternalLink size={13} /></a>
        <div><button type="button" className="pill-button" onClick={onCancel}>Отмена</button><button type="button" className="pill-button solid" disabled={!ready} onClick={create}>Добавить номер</button></div>
      </footer>
    </div>
  </div>;
}

function snippetFor(kind: string, agentId: string) {
  const body = { agentId: agentId || "ИДЕНТИФИКАТОР_АГЕНТА", toNumber: "+79001234567", variables: { caller_name: "Иван", caller_purpose: "Уточнить наличие 43 размера" } };
  if (kind === "TypeScript") {
    return `const response = await fetch("https://ВАШ_ДОМЕН/api/voice/calls", {\n  method: "POST",\n  headers: {\n    "content-type": "application/json",\n    authorization: "Basic " + btoa("admin:ПАРОЛЬ_ПАНЕЛИ"),\n  },\n  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}),\n});\nconst { call } = await response.json();\nconsole.log(call.id, call.status);`;
  }
  if (kind === "Python") {
    return `import requests\n\nresponse = requests.post(\n    "https://ВАШ_ДОМЕН/api/voice/calls",\n    auth=("admin", "ПАРОЛЬ_ПАНЕЛИ"),\n    json=${JSON.stringify(body, null, 4).replace(/\n/g, "\n    ").replace(/"([a-z_]+)":/g, '"$1":')},\n    timeout=30,\n)\nprint(response.json()["call"]["id"])`;
  }
  return `curl -u admin:ПАРОЛЬ_ПАНЕЛИ \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body)}' \\\n  https://ВАШ_ДОМЕН/api/voice/calls`;
}

const timezones = [
  { id: "Europe/Kaliningrad", label: "Калининград (UTC+2)" },
  { id: "Europe/Moscow", label: "Москва (UTC+3)" },
  { id: "Europe/Samara", label: "Самара (UTC+4)" },
  { id: "Asia/Yekaterinburg", label: "Екатеринбург (UTC+5)" },
  { id: "Asia/Omsk", label: "Омск (UTC+6)" },
  { id: "Asia/Krasnoyarsk", label: "Красноярск (UTC+7)" },
  { id: "Asia/Irkutsk", label: "Иркутск (UTC+8)" },
  { id: "Asia/Vladivostok", label: "Владивосток (UTC+10)" },
  { id: "Asia/Almaty", label: "Алматы (UTC+5)" },
  { id: "Europe/Minsk", label: "Минск (UTC+3)" },
  { id: "UTC", label: "UTC" },
];

const providerLabels: Record<Provider, string> = { yandex: "Yandex AI Studio", deepseek: "DeepSeek", openai: "OpenAI", xai: "xAI Grok Voice" };
const models: Array<{ id: string; provider: Provider; label: string; note: string }> = [
  { id: "speech-realtime-260528", provider: "yandex", label: "Speech Realtime 260528", note: "Основная модель Yandex" },
  { id: "speech-realtime-250923", provider: "yandex", label: "Speech Realtime 250923", note: "Предыдущая стабильная версия" },
  { id: "speech-realtime-deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash Realtime", note: "Экспериментальная, может отвечать медленнее" },
  { id: "grok-voice-think-fast-2.0", provider: "xai", label: "Grok Voice Think Fast 2.0", note: "Единственная realtime-модель xAI, отвечает за 0,7 с" },
  { id: "gpt-realtime-2.1", provider: "openai", label: "GPT Realtime 2.1", note: "Флагманская модель OpenAI" },
  { id: "gpt-realtime-2.1-mini", provider: "openai", label: "GPT Realtime 2.1 mini", note: "Быстрее и экономичнее" },
  { id: "gpt-realtime-2", provider: "openai", label: "GPT Realtime 2", note: "Предыдущее поколение" },
  { id: "gpt-realtime-1.5", provider: "openai", label: "GPT Realtime 1.5", note: "Совместимая стабильная версия" },
];
const yandexVoices = ["filipp", "alena", "ermil", "jane", "omazh", "zahar", "dasha", "julia", "lera", "masha", "marina", "alexander", "kirill", "anton", "madi_ru", "saule_ru", "zamira_ru", "zhanar_ru", "yulduz_ru", "john", "lea", "naomi", "amira", "madi", "saule", "zhanar", "nigora", "zamira", "yulduz"];
const openaiVoices = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
const xaiVoices = [
  "xai_rex · мужской, 128 Гц",
  "xai_sal · мужской, 133 Гц",
  "xai_helios · женский, 205 Гц",
  "xai_castor · женский, 207 Гц",
  "xai_helix · женский, 207 Гц",
  "xai_ursa · женский, 216 Гц",
  "xai_kepler · женский, 219 Гц",
  "xai_lumen · женский, 219 Гц",
  "xai_naksh · женский, 229 Гц",
  "xai_zagan · женский, 229 Гц",
  "xai_leo · женский, 232 Гц",
  "xai_celeste · женский, 233 Гц",
  "xai_luna · женский, 233 Гц",
  "xai_altair · женский, 235 Гц",
  "xai_perseus · женский, 236 Гц",
  "xai_eve · женский, 238 Гц",
  "xai_zenith · женский, 238 Гц",
  "xai_atlas · женский, 241 Гц",
  "xai_carina · женский, 242 Гц",
  "xai_lux · женский, 245 Гц",
  "xai_ara · женский, 251 Гц",
  "xai_iris · женский, 251 Гц",
  "xai_orion · женский, 251 Гц",
  "xai_cosmo · женский, 253 Гц",
  "xai_rigel · женский, 258 Гц",
  "xai_sirius · женский, 259 Гц",
].map((entry) => { const [id, note] = entry.split(" · "); return { id, note: note || "" }; });
// Что каждый инструмент делает в звонке: без этого список выглядит набором слов.
const toolNotes: Record<string, string> = {
  contact_context: "Перед ответом смотрит карточку клиента и о чём говорили в прошлые звонки",
  update_contact: "Сохраняет имя и язык клиента в карточку, чтобы не спрашивать снова",
  remember_note: "Запоминает важный факт о клиенте для следующих звонков",
  move_pipeline: "Двигает клиента по воронке: новый → квалифицирован → закрыт",
  transfer_call: "Переводит звонок живому сотруднику на добавочный номер",
  end_call: "Сам завершает звонок, когда разговор закончен",
  search_knowledge: "Ищет ответ в базе знаний агента вместо того, чтобы придумывать",
  dtmf: "Нажимает цифры в тональном меню, чтобы пробиться к человеку",
  web_search: "Ищет в интернете во время разговора",
  file_search: "Ищет в загруженном хранилище файлов провайдера",
  mcp: "Подключает внешний MCP-сервер с его инструментами",
  function: "Вызывает ваш webhook и передаёт ответ агенту",
};

const builtins = [
  ["contact_context", "Память и карточка клиента"], ["update_contact", "Изменить контакт"], ["move_pipeline", "Переместить по воронке"],
  ["remember_note", "Запомнить факт"], ["transfer_call", "Перевести оператору"], ["end_call", "Завершить звонок"],
  ["search_knowledge", "Поиск по базе знаний"],
];
const operatorPresets: Record<string, { dialFormat: string; fromUser: string; transport: "udp" | "tcp"; label: string; hint: string }> = {
  custom: { dialFormat: "e164", fromUser: "number", transport: "udp", label: "Другой SIP-оператор", hint: "" },
  sipnet: { dialFormat: "ru7", fromUser: "login", transport: "udp", label: "SIPNET", hint: "Registrar: sipnet.ru. Логин — SIP ID из кабинета, регистрация идёт от него, а не от номера. Исходящие набираются в международном формате без плюса: 7XXXXXXXXXX. Если прямой номер не куплен, в поле «Номер телефона / DID» укажите свой SIP ID — по нему маршрутизируется входящий." },
  telphin: { dialFormat: "ru7", fromUser: "login", transport: "udp", label: "Телфин", hint: "Личный хост вида sip1234.telphin.ru, SIP-логин вида 100123456*100, исходящие в формате 7XXXXXXXXXX, регистрация от логина." },
  mango: { dialFormat: "e164", fromUser: "number", transport: "udp", label: "MANGO OFFICE", hint: "MANGO выдаёт хост вида sipXXXX.mangosip.ru. Исходящие принимает в формате +7XXXXXXXXXX." },
  novofon: { dialFormat: "e164", fromUser: "number", transport: "udp", label: "Novofon / Zadarma", hint: "Registrar: sip.novofon.com. Логин — номер вида 1234567, исходящие в формате +7XXXXXXXXXX." },
};
const emptySettings: Settings = { yandexFolderId: "", yandexApiKey: "", openaiApiKey: "", openaiProjectId: "", xaiApiKey: "", gatewayPublicUrl: "", smtpHost: "", smtpPort: 587, smtpUser: "", smtpPassword: "", smtpFrom: "", phoneConnections: [] };

function id() { return crypto.randomUUID(); }
function freshAgent(): Agent {
  return {
    id: "", name: "Новый голосовой агент", description: "", provider: "yandex", model: "speech-realtime-260528",
    instructions: templates["Оператор поддержки"], variables: [{ id: id(), key: "service_name", value: "" }],
    tools: [
      { id: id(), type: "ascn", name: "contact_context" },
      { id: id(), type: "ascn", name: "update_contact" },
      { id: id(), type: "ascn", name: "remember_note" },
    ],
    synthesisEnabled: true, voice: "filipp", role: "", speed: 1, recognitionLanguage: "auto",
    vadEnabled: true, vadThreshold: 0.5, silenceDurationMs: 800, speaksFirst: false, firstMessage: "Здравствуйте! Чем могу помочь?",
    maxCallSeconds: 0, ambientSound: "none", ambientVolume: 0.3, outputGain: 1.6,
    guardrails: "", pronunciations: [], keyterms: "", followUpSeconds: 0, followUpMessage: "",
    allowInterruptions: true, shareCallerNumber: true, timezone: "Europe/Moscow",
    avatar: "", notifyEmail: "", knowledge: [], active: true,
  };
}

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

export default function VoiceAgents({ notify }: { notify: (message: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [search, setSearch] = useState("");
  const [builder, setBuilder] = useState<{ seed: string; starter?: () => Agent } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(emptySettings);

  const load = () => Promise.all([
    fetch("/api/voice/agents").then((response) => response.json()),
    fetch("/api/voice/settings").then((response) => response.json()),
  ]).then(([agentData, settingsData]) => {
    setAgents(agentData.agents || []);
    setSettings((current) => ({ ...current, ...settingsData, yandexApiKey: "", openaiApiKey: "", xaiApiKey: "", phoneConnections: (settingsData.phoneConnections || []).map((item: PhoneConnection) => ({ ...item, password: "" })) }));
  }).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);

  async function saveAgent() {
    if (!agent) return;
    setSaving(true);
    const response = await fetch("/api/voice/agents", { method: agent.id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agent) });
    const result = await response.json();
    setSaving(false);
    if (!response.ok) return notify(result.error || "Не удалось сохранить агента");
    setAgent(result.agent);
    setAgents((current) => agent.id ? current.map((item) => item.id === result.agent.id ? result.agent : item) : [...current, result.agent]);
    notify("Голосовой агент сохранён");
  }

  async function publishAgent(live: boolean) {
    if (!agent?.id) return notify("Сначала сохраните агента");
    const response = await fetch("/api/voice/agents/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: agent.id, live }) });
    const result = await response.json();
    if (!response.ok) return notify(result.error || "Не удалось опубликовать");
    setAgent(result.agent);
    setAgents((current) => current.map((item) => item.id === result.agent.id ? result.agent : item));
    notify(live ? "Агент опубликован — звонки идут по нему" : "Публикация снята");
  }

  async function removeAgent(target: Agent) {
    if (!window.confirm(`Удалить агента «${target.name}»?`)) return;
    const response = await fetch(`/api/voice/agents?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
    if (!response.ok) return notify("Не удалось удалить агента");
    setAgents((current) => current.filter((item) => item.id !== target.id));
    setAgent(null);
    notify("Голосовой агент удалён");
  }

  async function saveSettings() {
    setSaving(true);
    const response = await fetch("/api/voice/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    const result = await response.json();
    setSaving(false);
    if (!response.ok) return notify(result.error || "Не удалось сохранить подключение");
    setSettings((current) => ({ ...current, ...result, yandexApiKey: "", openaiApiKey: "", phoneConnections: (result.phoneConnections || []).map((item: PhoneConnection) => ({ ...item, password: "" })) }));
    notify("AI-провайдеры и телефонные номера сохранены");
  }

  // Номер добавляется прямо из карточки агента, поэтому шлём полные настройки:
  // частичный PUT затирает уже сохранённые номера.
  async function addPhoneNumber(connection: PhoneConnection) {
    const next = { ...settings, phoneConnections: [...settings.phoneConnections, connection] };
    const response = await fetch("/api/voice/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    const result = await response.json();
    if (!response.ok) return notify(result.error || "Не удалось сохранить номер");
    setSettings((current) => ({ ...current, ...result, yandexApiKey: "", openaiApiKey: "", xaiApiKey: "", phoneConnections: result.phoneConnections || [] }));
    notify("Номер подключён к агенту");
  }

  if (loading) return <div className="voice-loading">Загружаем голосовых агентов…</div>;
  if (showSettings) return <ConnectionSettings agents={agents} settings={settings} setSettings={setSettings} saving={saving} onSave={saveSettings} onBack={() => setShowSettings(false)} />;
  if (agent) return <AgentEditor agent={agent} setAgent={setAgent} settings={settings} saving={saving} onSave={saveAgent} onPublish={publishAgent} onAddNumber={addPhoneNumber} onBack={() => setAgent(null)} notify={notify} />;
  const visibleAgents = agents.filter((item) => !search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase()) || item.description.toLowerCase().includes(search.trim().toLowerCase()));

  return <>
    <div className="page-header"><div><h1>Голосовые агенты</h1><p>Собрать, настроить и проверить голосового агента для телефона.</p></div><div className="page-actions"><button className="ghost-button" onClick={() => setShowSettings(true)}><Settings2 size={16} /> Подключение и номера</button><button className="primary-button" onClick={() => setBuilder({ seed: "" })}><Plus size={16} /> Создать агента</button></div></div>
    <div className="agent-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти агента" aria-label="Найти агента" />{search && <button type="button" aria-label="Сбросить поиск" onClick={() => setSearch("")}><X size={14} /></button>}</div>
    {agents.length > 0 && <div className="agent-table">
      <header><span>Агент</span><span>Модель</span><span>Изменён</span><i /></header>
      {visibleAgents.map((item) => <article key={item.id}>
        <button type="button" className="agent-row-main" onClick={() => setAgent(item)}>
          <span className="agent-row-avatar">{item.avatar.startsWith("data:") ? <Image src={item.avatar} alt="" width={30} height={30} unoptimized /> : item.avatar ? <b>{item.avatar}</b> : <Bot size={15} />}</span>
          <strong>{item.name}</strong>
          <span className={`live-badge ${item.live ? (item.unpublished ? "changed" : "") : "draft"}`}><i />{item.live ? (item.unpublished ? "Черновик изменён" : "В эфире") : "Черновик"}</span>
          {!item.active && <span className="live-badge draft"><i />Не принимает</span>}
        </button>
        <span className="agent-row-model">{models.find((model) => model.id === item.model)?.label || item.model}</span>
        <time>{sinceText(item.updatedAt)}</time>
        <button className="icon-button agent-row-delete" aria-label={`Удалить ${item.name}`} onClick={() => void removeAgent(item)}><Trash2 size={15} /></button>
      </article>)}
      {!visibleAgents.length && <p className="agent-table-empty">По запросу «{search}» агентов нет.</p>}
    </div>}
    <div className="agent-starters">{starters.map((starter) => <button key={starter.label} className={`starter ${starter.tone}`} onClick={() => setBuilder({ seed: starter.label, starter: () => starter.apply(freshAgent()) })}><i><starter.icon size={16} /></i>{starter.label}</button>)}<button className="starter blank" onClick={() => setAgent({ ...freshAgent(), name: "Новый голосовой агент", instructions: "" })}><Plus size={16} /> Начать с нуля</button></div>
    {!agents.length && <section className="empty-state"><div className="add-circle"><Phone size={21} /></div><h2>Голосовых агентов пока нет</h2><p>Выберите сценарий выше — помощник задаст пару вопросов и соберёт промпт за вас.</p></section>}
    {builder && <AgentBuilderDialog seed={builder.seed} onCancel={() => setBuilder(null)} onSkip={() => { setBuilder(null); setAgent(builder.starter ? builder.starter() : freshAgent()); }} onReady={(draft) => { setBuilder(null); setAgent({ ...freshAgent(), ...draft }); }} notify={notify} />}
  </>;
}

function ConnectionSettings({ agents, settings, setSettings, saving, onSave, onBack }: { agents: Agent[]; settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>; saving: boolean; onSave: () => void; onBack: () => void }) {
  const patch = (changes: Partial<Settings>) => setSettings((current) => ({ ...current, ...changes }));
  const [dialog, setDialog] = useState<{ host: string } | null>(null);
  const addPhone = () => setDialog({ host: window.location.hostname });
  const updatePhone = (phoneId: string, changes: Partial<PhoneConnection>) => patch({ phoneConnections: settings.phoneConnections.map((item) => item.id === phoneId ? { ...item, ...changes } : item) });
  const removePhone = (phoneId: string) => patch({ phoneConnections: settings.phoneConnections.filter((item) => item.id !== phoneId) });
  const [checks, setChecks] = useState<Record<string, { ok?: boolean; detail: string }>>({});
  async function checkProvider(provider: string) {
    setChecks((current) => ({ ...current, [provider]: { detail: "Проверяю…" } }));
    try {
      const response = await fetch("/api/voice/settings/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
      const data = await response.json();
      setChecks((current) => ({ ...current, [provider]: { ok: data.ok, detail: data.detail || data.error || "Нет ответа" } }));
    } catch {
      setChecks((current) => ({ ...current, [provider]: { ok: false, detail: "Панель не смогла выполнить проверку" } }));
    }
  }
  function checkButton(provider: string, label: string) {
    const result = checks[provider];
    return <p className="provider-check"><button className="ghost-button" onClick={() => void checkProvider(provider)}>{label}</button>{result && <span className={result.ok === undefined ? "" : result.ok ? "ok" : "bad"}>{result.ok === true ? "✓ " : result.ok === false ? "✗ " : ""}{result.detail}</span>}</p>;
  }
  const stores = [
    { name: "SIPNET", note: "Регистрация по SIP ID, прямой номер отдельной услугой", url: "https://www.sipnet.ru/register" },
    { name: "MANGO OFFICE", note: "Российские городские и многоканальные номера", url: "https://www.mango-office.ru/products/virtual_number/" },
    { name: "Телфин", note: "SIP-номера России и других стран", url: "https://www.telphin.ru/products/virtual-numbers/sip-number" },
    { name: "Novofon", note: "Номера РФ через Госуслуги, 8-800 и SIP-trunk", url: "https://novofon.com/numbers/russian-federation/" },
  ];
  return <div className="voice-connection"><header className="voice-editor-header"><button onClick={onBack} aria-label="Назад">←</button><div><h1>Модели и телефонные номера</h1><p>Один номер можно назначить одному агенту. Ключи и SIP-пароли остаются только на сервере.</p></div></header>
    <div className="provider-settings-grid">
      <section className="voice-settings-card"><div className="voice-settings-heading"><Bot /><div><h2>Yandex AI Studio</h2><p>Для Speech Realtime и DeepSeek Realtime.</p></div><a className="provider-link" href="https://aistudio.yandex.ru/docs/ru/ai-studio/operations/get-api-key.html" target="_blank" rel="noreferrer">Создать ключ <ExternalLink size={14} /></a></div><div className="voice-settings-grid"><label>Идентификатор каталога<input value={settings.yandexFolderId} onChange={(event) => patch({ yandexFolderId: event.target.value })} placeholder="b1g..." /></label><label>API-ключ<input type="password" autoComplete="off" value={settings.yandexApiKey} onChange={(event) => patch({ yandexApiKey: event.target.value })} placeholder={settings.yandexApiKeyConfigured ? "Ключ уже сохранён — оставьте пустым" : "AQVN..."} /></label></div><p className="settings-hint">Сервисному аккаунту нужна роль <code>ai.models.user</code>. Этот же ключ обслуживает DeepSeek Realtime.</p>{checkButton("yandex", "Проверить Yandex")}{checkButton("deepseek", "Проверить DeepSeek")}</section>
      <section className="voice-settings-card"><div className="voice-settings-heading"><Bot /><div><h2>OpenAI Realtime</h2><p>Для GPT Realtime 2.1, mini, 2 и 1.5.</p></div><a className="provider-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Создать ключ <ExternalLink size={14} /></a></div><div className="voice-settings-grid"><label>API-ключ<input type="password" autoComplete="off" value={settings.openaiApiKey} onChange={(event) => patch({ openaiApiKey: event.target.value })} placeholder={settings.openaiApiKeyConfigured ? "Ключ уже сохранён — оставьте пустым" : "sk-proj-..."} /></label><label>Project ID <small>необязательно</small><input value={settings.openaiProjectId} onChange={(event) => patch({ openaiProjectId: event.target.value })} placeholder="proj_..." /></label></div>{checkButton("openai", "Проверить OpenAI")}</section>
      <section className="voice-settings-card"><div className="voice-settings-heading"><Bot /><div><h2>xAI Grok Voice</h2><p>Для Grok Voice Think Fast 2.0.</p></div><a className="provider-link" href="https://console.x.ai/home" target="_blank" rel="noreferrer">Создать ключ <ExternalLink size={14} /></a></div><div className="voice-settings-grid"><label>API-ключ<input type="password" autoComplete="off" value={settings.xaiApiKey} onChange={(event) => patch({ xaiApiKey: event.target.value })} placeholder={settings.xaiApiKeyConfigured ? "Ключ уже сохранён — оставьте пустым" : "xai-..."} /></label></div><p className="settings-hint">У ключа должен быть доступ к эндпоинту voice. Аудио приходит как PCM 24 кГц, в телефонию шлюз пересчитывает сам.</p>{checkButton("xai", "Проверить xAI")}</section>
    </div>
    <section className="voice-settings-card"><div className="voice-settings-heading"><Wrench /><div><h2>Голосовой шлюз</h2><p>Единый защищённый WebSocket для теста и телефонии.</p></div></div><div className="voice-settings-grid"><label className="wide">Публичный адрес voice gateway<input value={settings.gatewayPublicUrl} onChange={(event) => patch({ gatewayPublicUrl: event.target.value })} placeholder="wss://voice.example.ru/voice-ws/session" /><small>На сервере этот адрес направляется на voice-gateway:8787.</small></label></div></section>
    <section className="voice-settings-card"><div className="voice-settings-heading"><Mail /><div><h2>Почта для писем после звонка</h2><p>Обычный SMTP вашего домена или почтового сервиса. Без него письма из настроек агента не уйдут.</p></div></div><div className="voice-settings-grid">
      <label>SMTP-сервер<input value={settings.smtpHost} onChange={(event) => patch({ smtpHost: event.target.value })} placeholder="smtp.yandex.ru" /></label>
      <label>Порт<input type="number" min="1" max="65535" value={settings.smtpPort} onChange={(event) => patch({ smtpPort: Number(event.target.value) })} /><small>465 — TLS сразу, 587 — STARTTLS.</small></label>
      <label>Логин<input value={settings.smtpUser} onChange={(event) => patch({ smtpUser: event.target.value })} placeholder="robot@example.ru" /></label>
      <label>Пароль<input type="password" value={settings.smtpPassword} onChange={(event) => patch({ smtpPassword: event.target.value })} placeholder={settings.smtpPasswordConfigured ? "сохранён — оставьте пустым" : "пароль приложения"} /></label>
      <label className="wide">Адрес отправителя<input value={settings.smtpFrom} onChange={(event) => patch({ smtpFrom: event.target.value })} placeholder="robot@example.ru" /><small>Многие сервисы требуют, чтобы он совпадал с логином.</small></label>
    </div></section>
    <section className="voice-settings-card phone-sources"><div className="voice-settings-heading"><Phone /><div><h2>Где подключить обычный номер</h2><p>Выберите +7 или номер другой страны. После покупки оператор покажет SIP server, login и password.</p></div></div><div className="phone-source-grid">{stores.map((store) => <a key={store.name} href={store.url} target="_blank" rel="noreferrer"><strong>{store.name}</strong><span>{store.note}</span><em>Открыть сайт <ExternalLink size={13} /></em></a>)}</div><p className="settings-hint">Доступность российских номеров и требования к документам определяет оператор связи.</p></section>
    {dialog && <NewNumberDialog agents={agents} taken={settings.phoneConnections.length} serverHost={dialog.host} onCancel={() => setDialog(null)} onCreate={(connection) => { patch({ phoneConnections: [...settings.phoneConnections, connection] }); setDialog(null); }} />}
    <section className="phone-connections-section"><div className="phone-connections-heading"><div><h2>Номера и агенты</h2><p>Для каждого номера сохраните SIP-данные и выберите, кто отвечает.</p></div><button className="ghost-button" onClick={addPhone}><Plus size={15} /> Добавить номер</button></div>
      {!settings.phoneConnections.length && <div className="phone-empty"><Phone /><p>Номера ещё не добавлены.</p><button className="primary-button" onClick={addPhone}>Добавить первый номер</button></div>}
      {settings.phoneConnections.map((connection) => <section className="voice-settings-card phone-connection-card" key={connection.id}><div className="voice-settings-heading"><Phone /><div><h2>{connection.name || "Телефонный номер"}</h2><p>{connection.number || "Номер пока не указан"}</p></div><label className="switch"><b className="sr-only">Включить номер</b><input type="checkbox" checked={connection.enabled} onChange={(event) => updatePhone(connection.id, { enabled: event.target.checked })} /><span /></label><button className="icon-button" aria-label={`Удалить ${connection.name}`} onClick={() => removePhone(connection.id)}><Trash2 size={16} /></button></div><div className="voice-settings-grid"><label>Название<input value={connection.name} onChange={(event) => updatePhone(connection.id, { name: event.target.value })} placeholder="Основной номер" /></label><label>Оператор<select value={connection.providerPreset} onChange={(event) => { const preset = operatorPresets[event.target.value] || operatorPresets.custom; updatePhone(connection.id, { providerPreset: event.target.value, dialFormat: preset.dialFormat, fromUser: preset.fromUser, transport: preset.transport }); }}>{Object.entries(operatorPresets).map(([value, preset]) => <option key={value} value={value}>{preset.label}</option>)}</select>{operatorPresets[connection.providerPreset]?.hint && <small>{operatorPresets[connection.providerPreset].hint}</small>}</label><label>Номер телефона / DID<input value={connection.number} onChange={(event) => updatePhone(connection.id, { number: event.target.value })} placeholder="+7 495 000-00-00" /></label><label>Какой агент отвечает<select value={connection.agentId} onChange={(event) => updatePhone(connection.id, { agentId: event.target.value })}><option value="">Не назначен</option>{agents.map((item) => <option value={item.id} key={item.id}>{item.name} · {providerLabels[item.provider] || item.provider}</option>)}</select></label><label>SIP server / registrar<input value={connection.registrar} onChange={(event) => updatePhone(connection.id, { registrar: event.target.value })} placeholder="sip.provider.ru" /></label><label>Outbound proxy <small>необязательно</small><input value={connection.proxy} onChange={(event) => updatePhone(connection.id, { proxy: event.target.value })} placeholder="proxy.provider.ru" /></label><label>SIP login<input value={connection.username} onChange={(event) => updatePhone(connection.id, { username: event.target.value })} /></label><label>SIP password<input type="password" autoComplete="off" value={connection.password} onChange={(event) => updatePhone(connection.id, { password: event.target.value })} placeholder={connection.passwordConfigured ? "Пароль уже сохранён" : "Пароль"} /></label><label>Транспорт<select value={connection.transport} onChange={(event) => updatePhone(connection.id, { transport: event.target.value as "udp" | "tcp" })}><option value="udp">UDP</option><option value="tcp">TCP</option></select></label><label>Формат набора<select value={connection.dialFormat} onChange={(event) => updatePhone(connection.id, { dialFormat: event.target.value })}><option value="e164">+7XXXXXXXXXX</option><option value="ru7">7XXXXXXXXXX</option><option value="ru8">8XXXXXXXXXX</option><option value="raw">Как ввели</option></select><small>Как оператор принимает исходящие.</small></label><label>Регистрация от<select value={connection.fromUser} onChange={(event) => updatePhone(connection.id, { fromUser: event.target.value })}><option value="number">Номера телефона</option><option value="login">SIP-логина</option></select><small>Телфин требует логин.</small></label><label>Живой оператор <small>необязательно</small><input value={connection.operatorExtension} onChange={(event) => updatePhone(connection.id, { operatorExtension: event.target.value })} placeholder="Внутренний или внешний номер" /></label></div></section>)}
    </section>
    <div className="voice-save-bar"><button className="ghost-button" onClick={onBack}>Отмена</button><button className="primary-button" disabled={saving} onClick={onSave}><Save size={16} /> {saving ? "Сохраняем…" : "Сохранить подключения"}</button></div>
  </div>;
}

function AgentEditor({ agent, setAgent, settings, saving, onSave, onPublish, onAddNumber, onBack, notify }: { agent: Agent; onPublish: (live: boolean) => void; onAddNumber: (connection: PhoneConnection) => void; setAgent: React.Dispatch<React.SetStateAction<Agent | null>>; settings: Settings; saving: boolean; onSave: () => void; onBack: () => void; notify: (message: string) => void }) {
  const patch = (changes: Partial<Agent>) => setAgent((current) => current ? { ...current, ...changes } : current);
  const [toolType, setToolType] = useState("ascn:contact_context");
  const [preview, setPreview] = useState<{ state: "idle" | "loading" | "error"; detail?: string }>({ state: "idle" });
  const [tab, setTab] = useState("config");
  const [tester, setTester] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [numberDialog, setNumberDialog] = useState<{ host: string } | null>(null);
  const guardrailRef = useRef<HTMLTextAreaElement | null>(null);
  const [toolUsage, setToolUsage] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!agent.id) return;
    let alive = true;
    fetch(`/api/voice/insights?days=30&agentId=${encodeURIComponent(agent.id)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => { if (alive) setToolUsage(result.toolUsage || {}); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [agent.id]);
  const [improving, setImproving] = useState(false);
  const [snippet, setSnippet] = useState("curl");
  const avatarInput = useRef<HTMLInputElement | null>(null);
  const knowledgeInput = useRef<HTMLInputElement | null>(null);

  async function improvePrompt() {
    setImproving(true);
    try {
      const response = await fetch("/api/voice/improve-prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: agent.provider, instructions: agent.instructions, name: agent.name, description: agent.description }),
      });
      const result = await response.json();
      if (!response.ok) return notify(result.error || "Модель не ответила");
      patch({ instructions: result.instructions });
      notify("Промпт переписан — посмотрите и сохраните");
    } finally {
      setImproving(false);
    }
  }

  async function addAvatar(file: File | undefined) {
    if (!file) return;
    if (file.size > 200000) return notify("Картинка больше 200 КБ — возьмите поменьше");
    const reader = new FileReader();
    reader.onload = () => patch({ avatar: String(reader.result || "") });
    reader.readAsDataURL(file);
  }

  async function addKnowledge(files: FileList | null) {
    if (!files?.length) return;
    const added: Agent["knowledge"] = [];
    for (const file of [...files].slice(0, 20)) {
      if (file.size > 300000) { notify(`${file.name}: больше 300 КБ, пропущен`); continue; }
      added.push({ id: id(), name: file.name, text: await file.text() });
    }
    if (added.length) patch({ knowledge: [...agent.knowledge, ...added].slice(0, 20) });
  }
  const previewRef = useRef<HTMLAudioElement | null>(null);
  async function playVoice() {
    previewRef.current?.pause();
    setPreview({ state: "loading" });
    try {
      const response = await fetch("/api/voice/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: agent.provider, model: agent.model, voice: agent.voice, phrase: agent.firstMessage || "Здравствуйте! Чем могу помочь?" }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setPreview({ state: "error", detail: data.error || `провайдер вернул ${response.status}` });
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      previewRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreview({ state: "idle" }); };
      await audio.play();
      setPreview({ state: "idle" });
    } catch {
      setPreview({ state: "error", detail: "не удалось воспроизвести" });
    }
  }
  const providerModels = models.filter((model) => model.provider === agent.provider);
  const availableVoices = agent.provider === "openai" ? openaiVoices : yandexVoices;
  function changeProvider(provider: Provider) {
    patch({
      provider,
      model: models.find((model) => model.provider === provider)?.id || "",
      voice: provider === "openai" ? "marin" : provider === "xai" ? "xai_ara" : "filipp",
      tools: provider === "openai" ? agent.tools.filter((tool) => tool.type !== "web_search" && tool.type !== "file_search") : provider === "xai" ? agent.tools.filter((tool) => tool.type !== "file_search" && tool.type !== "mcp") : agent.tools,
    });
    setToolType("ascn:contact_context");
  }
  function addTool() {
    if (agent.tools.length >= 8) return notify("Можно подключить не больше восьми инструментов");
    const [type, name] = toolType.split(":");
    if (type === "ascn" && agent.tools.some((tool) => tool.type === "ascn" && tool.name === name)) return notify("Этот инструмент уже добавлен");
    let tool: Tool;
    if (type === "ascn") tool = { id: id(), type, name };
    else if (type === "dtmf") tool = { id: id(), type };
    else if (type === "web_search") tool = { id: id(), type };
    else if (type === "file_search") tool = { id: id(), type, vectorStoreId: "" };
    else if (type === "mcp") tool = { id: id(), type, label: "mcp_server", url: "", authorization: "", requireApproval: "never" };
    else tool = { id: id(), type: "function", name: "my_function", description: "", parameters: "{\n  \"type\": \"object\",\n  \"properties\": {}\n}", webhookUrl: "", authorization: "" };
    patch({ tools: [...agent.tools, tool] });
  }
  function updateTool(toolId: string, changes: Partial<Tool>) { patch({ tools: agent.tools.map((tool) => tool.id === toolId ? { ...tool, ...changes } : tool) }); }
  return <div className={`voice-editor-page${tester ? "" : " solo"}`}><div className="voice-editor-pane">
      <button type="button" className="text-button back-link" onClick={onBack}><ArrowLeft size={15} /> Назад</button>
      <header className="agent-hero">
        <div className="avatar-picker">
          <button type="button" className="agent-avatar" onClick={() => setAvatarOpen((current) => !current)} aria-expanded={avatarOpen} aria-label="Сменить аватар">{agent.avatar.startsWith("data:") ? <Image src={agent.avatar} alt="" width={56} height={56} unoptimized /> : agent.avatar ? <b>{agent.avatar}</b> : <Bot size={22} />}</button>
          <input ref={avatarInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={(event) => { void addAvatar(event.target.files?.[0]); setAvatarOpen(false); }} />
          {avatarOpen && <div className="avatar-menu">
            <div className="avatar-grid">{avatarEmoji.map((emoji) => <button type="button" key={emoji} className={agent.avatar === emoji ? "active" : ""} onClick={() => { patch({ avatar: emoji }); setAvatarOpen(false); }}>{emoji}</button>)}</div>
            <footer><button type="button" className="text-button" onClick={() => avatarInput.current?.click()}><Upload size={13} /> Картинка</button>{agent.avatar && <button type="button" className="text-button" onClick={() => { patch({ avatar: "" }); setAvatarOpen(false); }}>Убрать</button>}</footer>
          </div>}
        </div>
        <div>
          <h1>{agent.name.trim() || "Новый голосовой агент"}</h1>
          <div className="agent-hero-meta">
            <span>{agent.publishedAt ? `Опубликован ${new Date(agent.publishedAt).toLocaleString("ru-RU")}` : "Ещё не публиковался"}</span>
            <span className={`live-badge ${agent.live ? (agent.unpublished ? "changed" : "") : "draft"}`}><i />{agent.live ? (agent.unpublished ? "Черновик изменён" : "В эфире") : "Черновик"}</span>

          </div>
        </div>
        <div className="agent-hero-actions">
          <label className="voice-active"><span>Принимать звонки</span><span className="switch"><input type="checkbox" checked={agent.active} onChange={(event) => patch({ active: event.target.checked })} /><span /></span></label>
          <button type="button" className={`pill-button${tester ? " active" : ""}`} onClick={() => setTester((current) => !current)}><AudioLines size={15} /> Проверить голосом</button>
          {agent.live && <button type="button" className="pill-button" onClick={() => onPublish(false)}>Снять</button>}
          <button type="button" className="pill-button solid" disabled={!agent.id} onClick={() => onPublish(true)}>Опубликовать</button>
        </div>
      </header>
<div className="agent-tabs">{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
<div className="voice-form-scroll">
      {tab === "config" && <>
        {(() => {
          const mine = settings.phoneConnections.filter((item) => !item.agentId || item.agentId === agent.id);
          return <div className="setup-banner"><Phone size={16} /><strong>{mine.length ? "Номер подключён" : "Подключите номер"}</strong><span>{mine.length ? mine.map((item) => item.number || item.name).join(", ") : "чтобы на агента можно было позвонить"}</span><button type="button" className="pill-button solid" onClick={() => setNumberDialog({ host: window.location.hostname })}>{mine.length ? "Ещё номер" : "Настроить"}</button></div>;
        })()}
        {numberDialog && <NewNumberDialog agents={[agent]} taken={settings.phoneConnections.length} serverHost={numberDialog.host} onCancel={() => setNumberDialog(null)} onCreate={(connection) => { onAddNumber({ ...connection, agentId: agent.id }); setNumberDialog(null); }} />}<label className="voice-field"><span>Имя</span><input value={agent.name} onChange={(event) => patch({ name: event.target.value })} maxLength={80} /></label><label className="voice-field"><span>Описание <i>необязательно</i></span><input value={agent.description} onChange={(event) => patch({ description: event.target.value })} placeholder="Для чего нужен этот агент" /></label><div className="agent-model-grid"><label className="voice-field"><span>AI-провайдер</span><select value={agent.provider} onChange={(event) => changeProvider(event.target.value as Provider)}>{(Object.keys(providerLabels) as Provider[]).map((value) => <option key={value} value={value}>{providerLabels[value]}</option>)}</select>{agent.provider === "deepseek" && <small>Модель размещена в Yandex AI Studio — нужен ключ и каталог Yandex.</small>}</label><label className="voice-field"><span>Realtime-модель</span><select value={agent.model} onChange={(event) => patch({ model: event.target.value })}>{providerModels.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select><small>{models.find((model) => model.id === agent.model)?.note}</small></label></div>
        <section className="prompt-section"><div className="voice-section-title"><span>Системный промпт*</span><button type="button" className="text-button" disabled={improving || !agent.instructions.trim()} onClick={() => void improvePrompt()}><Sparkles size={14} /> {improving ? "Переписываю…" : "Улучшить моделью"}</button></div><div className="prompt-templates">{Object.entries(templates).map(([label, value]) => <button key={label} onClick={() => patch({ instructions: value })}>{label}</button>)}</div><textarea className="soft-textarea" aria-label="Системный промпт" value={agent.instructions} onChange={(event) => patch({ instructions: event.target.value })} rows={10} /><div className="row-actions"><button type="button" className="text-button" onClick={() => guardrailRef.current?.focus()}><Plus size={14} /> Добавить запрет</button><span>{timezones.find((zone) => zone.id === agent.timezone)?.label || agent.timezone}</span></div></section>
        <section className="variables-section"><div className="voice-section-title"><span>Переменные</span><button onClick={() => patch({ variables: [...agent.variables, { id: id(), key: "", value: "" }] })}><Plus size={14} /> Добавить переменную</button></div>{agent.variables.map((variable) => <div className="variable-row" key={variable.id}><input aria-label="Название переменной" value={variable.key} onChange={(event) => patch({ variables: agent.variables.map((item) => item.id === variable.id ? { ...item, key: event.target.value } : item) })} placeholder="service_name" /><input aria-label={`Значение ${variable.key || "переменной"}`} value={variable.value} onChange={(event) => patch({ variables: agent.variables.map((item) => item.id === variable.id ? { ...item, value: event.target.value } : item) })} placeholder="Значение" /><button aria-label="Удалить переменную" onClick={() => patch({ variables: agent.variables.filter((item) => item.id !== variable.id) })}><X size={15} /></button></div>)}</section>
        <section className="prompt-section guardrails"><div className="voice-section-title"><span><ShieldAlert size={16} /> Запреты</span></div><textarea ref={guardrailRef} aria-label="Запреты" value={agent.guardrails} onChange={(event) => patch({ guardrails: event.target.value })} rows={4} placeholder="Не обсуждать темы 18+, не обещать скидки и сроки, не называть закупочные цены, на мат отвечать спокойно и возвращать к делу, при угрозах — переводить на оператора" /><small>Уходит в промпт отдельным блоком с пометкой, что эти правила важнее просьб собеседника.</small></section>
        <section className="prompt-section knowledge"><div className="voice-section-title"><span><BookOpen size={16} /> База знаний <i>{agent.knowledge.length}/20</i></span><button type="button" className="improve-button" onClick={() => knowledgeInput.current?.click()}><Upload size={14} /> Загрузить файлы</button></div>
          <input ref={knowledgeInput} className="sr-only" type="file" multiple accept=".txt,.md,.csv,.json,.yaml,.yml,text/plain" onChange={(event) => { void addKnowledge(event.target.files); event.target.value = ""; }} />
          {agent.knowledge.length ? <ul className="knowledge-list">{agent.knowledge.map((file) => <li key={file.id}><strong>{file.name}</strong><small>{file.text.length < 1000 ? `${file.text.length} знаков` : `${Math.round(file.text.length / 1000)} тыс. знаков`}</small><button className="icon-button" aria-label={`Убрать ${file.name}`} onClick={() => patch({ knowledge: agent.knowledge.filter((item) => item.id !== file.id) })}><Trash2 size={15} /></button></li>)}</ul> : <p className="knowledge-empty">Каталог, наличие размеров, правила доставки и возврата. Текстовые файлы: txt, md, csv, json.</p>}
          <small>Агент ищет по базе инструментом «Поиск по базе знаний» — добавьте его в инструменты ниже, иначе файлы не будут использоваться.</small>
        </section>
        <section className="setting-block">
          <div className="setting-row"><div><strong>Агент говорит первым</strong><p>Включено — агент открывает разговор приветствием. Выключено — ждёт, пока заговорит собеседник.</p></div><label className="switch"><b className="sr-only">Агент говорит первым</b><input type="checkbox" checked={agent.speaksFirst} onChange={(event) => patch({ speaksFirst: event.target.checked })} /><span /></label></div>
          {agent.speaksFirst && <textarea className="soft-textarea" aria-label="Первая фраза" rows={2} value={agent.firstMessage} onChange={(event) => patch({ firstMessage: event.target.value })} placeholder="Необязательно: точная фраза приветствия, или оставьте пустым — агент придумает сам" />}
          <div className="setting-row filled"><div><strong>Собеседник может перебивать</strong><p>Включено — речь собеседника прерывает агента на полуслове.</p></div><label className="switch"><b className="sr-only">Собеседник может перебивать</b><input type="checkbox" checked={agent.allowInterruptions} onChange={(event) => patch({ allowInterruptions: event.target.checked })} /><span /></label></div>
          <div className="setting-row"><div><strong>Агент знает номер звонящего</strong><p>Включено — номер попадает в промпт, агент может его назвать.</p></div><label className="switch"><b className="sr-only">Агент знает номер звонящего</b><input type="checkbox" checked={agent.shareCallerNumber} onChange={(event) => patch({ shareCallerNumber: event.target.checked })} /><span /></label></div>
        </section>
        <section className="tools-section"><div className="voice-section-title"><span>Инструменты <i>{agent.tools.length}/8</i></span></div><div className="tool-adder"><select aria-label="Тип инструмента" value={toolType} onChange={(event) => setToolType(event.target.value)}>{builtins.map(([value, label]) => <option key={value} value={`ascn:${value}`}>ASCN · {label}</option>)}<option value="dtmf">Тональный набор (IVR)</option>{transportOf(agent.provider) === "yandex" && <><option value="web_search">Yandex Web Search</option><option value="file_search">Yandex File Search</option></>}{transportOf(agent.provider) === "xai" && <option value="web_search">Поиск в интернете (xAI)</option>}<option value="mcp">MCP-сервер</option><option value="function">Своя функция / webhook</option></select><button onClick={addTool}><Plus size={15} /> Добавить</button></div><div className="tool-list">{agent.tools.map((tool) => <ToolRow key={tool.id} tool={tool} used={toolUsage ? (toolUsage[tool.type === "ascn" ? `ascn_${tool.name}` : tool.type === "dtmf" ? "ascn_press_digit" : String(tool.name || tool.type)] || 0) : undefined} onChange={(changes) => updateTool(tool.id, changes)} onDelete={() => patch({ tools: agent.tools.filter((item) => item.id !== tool.id) })} />)}</div></section>
      </>}
      {tab === "speech" && <section className="setting-block">
        <div className="setting-row"><div><strong>Голос</strong><p>Выберите голос, который подходит вашему делу. Частоты замерены на живом синтезе: у xAI мужских всего два.</p></div>
          <div className="row-control">
            <button type="button" className="text-button" disabled={preview.state === "loading" || !agent.voice} onClick={() => void playVoice()}><AudioLines size={14} /> {preview.state === "loading" ? "Генерирую…" : "Прослушать"}</button>
            {transportOf(agent.provider) === "xai"
              ? <select aria-label="Голос" value={agent.voice} onChange={(event) => patch({ voice: event.target.value })}>{!xaiVoices.some((voice) => voice.id === agent.voice) && <option value={agent.voice}>{agent.voice}</option>}{xaiVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.note ? `${voice.id} · ${voice.note}` : voice.id}</option>)}</select>
              : <select aria-label="Голос" value={agent.voice} onChange={(event) => patch({ voice: event.target.value })}>{availableVoices.map((voice) => <option key={voice}>{voice}</option>)}</select>}
          </div>
          {preview.state === "error" && <small className="voice-preview-error">{preview.detail}</small>}
        </div>

        <div className="setting-row"><div><strong>Произношение</strong><p>Как читать вслух бренды и аббревиатуры: латиница иначе звучит по-английски.</p></div>
          <button type="button" className="text-button" disabled={agent.pronunciations.length >= 40} onClick={() => patch({ pronunciations: [...agent.pronunciations, { id: id(), from: "", to: "" }] })}><Plus size={14} /> Добавить произношение</button>
        </div>
        {agent.pronunciations.length > 0 && <div className="pronunciation-list">{agent.pronunciations.map((item) => <div key={item.id}><input value={item.from} onChange={(event) => patch({ pronunciations: agent.pronunciations.map((row) => row.id === item.id ? { ...row, from: event.target.value } : row) })} placeholder="Nike" aria-label="Как написано" /><span>→</span><input value={item.to} onChange={(event) => patch({ pronunciations: agent.pronunciations.map((row) => row.id === item.id ? { ...row, to: event.target.value } : row) })} placeholder="найки" aria-label="Как читать" /><button className="icon-button" aria-label="Убрать замену" onClick={() => patch({ pronunciations: agent.pronunciations.filter((row) => row.id !== item.id) })}><Trash2 size={15} /></button></div>)}</div>}

        <div className="setting-row"><div><strong>Ключевые слова</strong><p>Названия и артикулы, которые часто звучат в звонках — модель перестанет подменять их похожими.</p></div></div>
        <textarea className="soft-textarea" aria-label="Ключевые слова" rows={2} value={agent.keyterms} onChange={(event) => patch({ keyterms: event.target.value })} placeholder="New Balance, Air Force, СДЭК, 43 размер" />

        {transportOf(agent.provider) === "yandex" && <div className="setting-row"><div><strong>Язык</strong><p>Улучшает распознавание, если звонящие говорят на одном языке.</p></div>
          <select aria-label="Язык" value={agent.recognitionLanguage} onChange={(event) => patch({ recognitionLanguage: event.target.value })}><option value="auto">Автоопределение</option><option value="ru-RU">Русский</option><option value="kk-KZ">Казахский</option><option value="en-US">Английский</option><option value="uz-UZ">Узбекский</option></select>
        </div>}

        {transportOf(agent.provider) === "yandex" && <div className="setting-row"><div><strong>Скорость речи</strong><p>Ускорить или замедлить агента.</p></div>
          <select aria-label="Скорость речи" value={String(agent.speed)} onChange={(event) => patch({ speed: Number(event.target.value) })}>{["0.8", "0.9", "1", "1.1", "1.2", "1.3", "1.5"].map((value) => <option key={value} value={value}>{value.replace(".", ",")}×</option>)}</select>
        </div>}

        <div className="setting-row"><div><strong>Продолжение после паузы</strong><p>Подталкивать собеседника, когда он замолчал. Пауза задаётся ниже.</p></div>
          <label className="switch"><b className="sr-only">Продолжение после паузы</b><input type="checkbox" checked={agent.followUpSeconds > 0} onChange={(event) => patch({ followUpSeconds: event.target.checked ? 10 : 0 })} /><span /></label>
        </div>
        {agent.followUpSeconds > 0 && <div className="processing-grid inline">
          <label>Пауза, сек<input type="number" min="1" max="120" value={agent.followUpSeconds} onChange={(event) => patch({ followUpSeconds: Number(event.target.value) })} /></label>
          <label className="wide">Что сказать в тишину<input value={agent.followUpMessage} onChange={(event) => patch({ followUpMessage: event.target.value })} placeholder="Коротко переспроси, слышно ли тебя" /></label>
        </div>}

        <details className="speech-advanced"><summary>Тонкая настройка: распознавание, фон, громкость</summary>
          <div className="processing-grid">
            <label>Чувствительность<input type="number" min="0" max="1" step="0.1" value={agent.vadThreshold} onChange={(event) => patch({ vadThreshold: Number(event.target.value) })} /></label>
            <label>Длительность тишины, мс<input type="number" min="100" max="5000" step="100" value={agent.silenceDurationMs} onChange={(event) => patch({ silenceDurationMs: Number(event.target.value) })} /></label>
            <label>Громкость голоса<input type="number" min="1" max="4" step="0.1" value={agent.outputGain} onChange={(event) => patch({ outputGain: Number(event.target.value) })} /><small>1,6 — обычно то, что нужно.</small></label>
            <label>Фоновый звук<select value={agent.ambientSound} onChange={(event) => patch({ ambientSound: event.target.value })}><option value="none">Без фона</option><option value="office">Офис</option><option value="cafe">Кафе</option><option value="street">Улица</option></select></label>
            <label>Громкость фона<input type="number" min="0" max="1" step="0.05" value={agent.ambientVolume} onChange={(event) => patch({ ambientVolume: Number(event.target.value) })} /></label>
            <label>Лимит звонка, сек<input type="number" min="0" max="7200" step="30" value={agent.maxCallSeconds} onChange={(event) => patch({ maxCallSeconds: Number(event.target.value) })} /><small>0 — без ограничения.</small></label>
          </div>
        </details>
      </section>}
      {tab === "deploy" && <>
        <section className="prompt-section integration"><div className="voice-section-title"><span><Code2 size={16} /> Подключение</span></div>
          <label className="voice-field"><span>Письмо после звонка <i>необязательно</i></span><input value={agent.notifyEmail} onChange={(event) => patch({ notifyEmail: event.target.value })} placeholder="boss@example.com" /><small>{settings.smtpHost ? `Отправляем через ${settings.smtpHost}. Итог, длительность и подтверждение придут после каждого звонка.` : "Сначала укажите SMTP-сервер в «Подключение и номера», иначе письма не уйдут."}</small></label>
          <div className="snippet-tabs">{["curl", "TypeScript", "Python"].map((kind) => <button type="button" key={kind} className={snippet === kind ? "active" : ""} onClick={() => setSnippet(kind)}>{kind}</button>)}</div>
          <pre className="snippet-code">{snippetFor(snippet, agent.id)}</pre>
          <small>Исходящий звонок этим агентом из своего кода. Пароль панели — тот же, что при входе.</small>
        </section>
      </>}
      {tab === "calls" && <AgentCalls agentId={agent.id} />}
      {tab === "insights" && <AgentInsights agentId={agent.id} />}
      </div><footer className="voice-editor-actions"><button className="ghost-button" onClick={onBack}>Отмена</button><button className="primary-button" disabled={saving} onClick={onSave}><Save size={15} /> {saving ? "Сохраняем…" : agent.id ? "Сохранить" : "Создать"}</button></footer></div>
    {tester && <VoiceTester agent={agent} settings={settings} notify={notify} />}
  </div>;
}

function ToolRow({ tool, used, onChange, onDelete }: { tool: Tool; used?: number; onChange: (changes: Partial<Tool>) => void; onDelete: () => void }) {
  const title = tool.type === "ascn" ? `ASCN · ${builtins.find(([value]) => value === tool.name)?.[1] || tool.name}` : tool.type === "dtmf" ? "Тональный набор (IVR)" : tool.type === "web_search" ? "Yandex Web Search" : tool.type === "file_search" ? "Yandex File Search" : tool.type === "mcp" ? "MCP-сервер" : "Своя функция";
  const note = toolNotes[tool.type === "ascn" ? String(tool.name) : tool.type] || "";
  return <article className="tool-row"><header><span><Wrench size={15} /> {title}{typeof used === "number" && <i className={used ? "used" : ""}>{used ? `вызван ${used} раз` : "ещё не вызывался"}</i>}</span><button aria-label={`Удалить ${title}`} onClick={onDelete}><Trash2 size={15} /></button></header>{note && <p className="tool-note">{note}</p>}{tool.type === "file_search" && <label>ID поискового индекса<input value={tool.vectorStoreId || ""} onChange={(event) => onChange({ vectorStoreId: event.target.value })} placeholder="fvt..." /></label>}{tool.type === "mcp" && <div className="tool-fields"><label>Название<input value={tool.label || ""} onChange={(event) => onChange({ label: event.target.value })} /></label><label>URL сервера<input value={tool.url || ""} onChange={(event) => onChange({ url: event.target.value })} placeholder="https://..." /></label><label>Authorization<input type="password" value={tool.authorization || ""} onChange={(event) => onChange({ authorization: event.target.value })} placeholder={tool.authorizationConfigured ? "Уже сохранён" : "Bearer ..."} /></label><label>Подтверждение<select value={tool.requireApproval || "never"} onChange={(event) => onChange({ requireApproval: event.target.value })}><option value="never">Не требуется</option><option value="always">Всегда</option></select></label></div>}{tool.type === "function" && <div className="tool-fields"><label>Имя функции<input value={tool.name || ""} onChange={(event) => onChange({ name: event.target.value })} /></label><label>Webhook URL<input value={tool.webhookUrl || ""} onChange={(event) => onChange({ webhookUrl: event.target.value })} placeholder="https://..." /></label><label className="wide">Описание<input value={tool.description || ""} onChange={(event) => onChange({ description: event.target.value })} /></label><label className="wide">JSON Schema<textarea rows={4} value={tool.parameters || "{}"} onChange={(event) => onChange({ parameters: event.target.value })} /></label><label className="wide">Authorization<input type="password" value={tool.authorization || ""} onChange={(event) => onChange({ authorization: event.target.value })} placeholder={tool.authorizationConfigured ? "Уже сохранён" : "Необязательно"} /></label></div>}</article>;
}

function VoiceTester({ agent, settings, notify }: { agent: Agent; settings: Settings; notify: (message: string) => void }) {
  const [status, setStatus] = useState<"idle" | "connecting" | "live">("idle");
  const [messages, setMessages] = useState<Array<{ role: "user" | "agent"; text: string }>>([]);
  const [textInput, setTextInput] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayRef = useRef(0);
  const agentTextRef = useRef("");

  function clearPlayback() { sourcesRef.current.forEach((source) => { try { source.stop(); } catch { /* The source may already be stopped. */ } }); sourcesRef.current = []; nextPlayRef.current = contextRef.current?.currentTime || 0; }
  function playPcm(base64: string) {
    const context = contextRef.current;
    if (!context) return;
    const bytes = bytesFromBase64(base64);
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    const buffer = context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, nextPlayRef.current);
    source.start(startAt);
    nextPlayRef.current = startAt + buffer.duration;
    sourcesRef.current.push(source);
    source.onended = () => { sourcesRef.current = sourcesRef.current.filter((item) => item !== source); };
  }
  function stop() {
    socketRef.current?.close(); streamRef.current?.getTracks().forEach((track) => track.stop()); contextRef.current?.close(); clearPlayback();
    socketRef.current = null; streamRef.current = null; contextRef.current = null; setStatus("idle");
  }
  useEffect(() => () => {
    socketRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void contextRef.current?.close();
  }, []);
  async function start() {
    if (!agent.id) return notify("Сначала сохраните голосового агента");
    if (agent.provider === "yandex" && (!settings.yandexApiKeyConfigured || !settings.yandexFolderId)) return notify("Сначала подключите Yandex AI Studio");
    if (agent.provider === "openai" && !settings.openaiApiKeyConfigured) return notify("Сначала подключите OpenAI Realtime");
    if (!settings.gatewayPublicUrl) return notify("Укажите публичный адрес voice gateway в подключении");
    setStatus("connecting");
    try {
      const tokenResponse = await fetch("/api/voice/test-token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) });
      const tokenResult = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenResult.error || "Не удалось авторизовать тестовую сессию");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext({ sampleRate: 24000 });
      streamRef.current = stream; contextRef.current = context; nextPlayRef.current = context.currentTime;
      const socketUrl = new URL(settings.gatewayPublicUrl);
      socketUrl.searchParams.set("agentId", agent.id);
      socketUrl.searchParams.set("token", tokenResult.token);
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      socket.onopen = () => {
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const input = event.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let index = 0; index < input.length; index += 1) pcm[index] = Math.max(-32768, Math.min(32767, input[index] * 32768));
          socket.send(JSON.stringify({ type: "audio", audio: base64FromBytes(new Uint8Array(pcm.buffer)) }));
        };
        source.connect(processor); processor.connect(context.destination); setStatus("live");
      };
      socket.onmessage = (message) => {
        const payload = JSON.parse(message.data);
        if (payload.type === "audio") playPcm(payload.audio);
        const event = payload.event;
        if (event?.type === "input_audio_buffer.speech_started") clearPlayback();
        if (event?.type === "conversation.item.input_audio_transcription.completed" && event.transcript) setMessages((current) => [...current, { role: "user", text: event.transcript }]);
        if (event?.type === "response.output_text.delta" || event?.type === "response.output_audio_transcript.delta") agentTextRef.current += event.delta || "";
        if (event?.type === "response.done" && agentTextRef.current) { const text = agentTextRef.current; agentTextRef.current = ""; setMessages((current) => [...current, { role: "agent", text }]); }
        if (event?.type === "error") notify(event.error?.message || "Ошибка Realtime API");
        if (payload.type === "error") notify(payload.error || "Не удалось открыть сессию");
      };
      socket.onclose = () => setStatus("idle");
    } catch (error) { stop(); notify(error instanceof Error ? error.message : "Нет доступа к микрофону"); }
  }
  function sendText() {
    if (!textInput.trim() || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "text", text: textInput.trim() }));
    setMessages((current) => [...current, { role: "user", text: textInput.trim() }]); setTextInput("");
  }
  return <aside className="voice-tester"><header><div><span className={`live-dot ${status}`} /><div><h2>Тестирование голосового агента</h2><p>{status === "live" ? "Сессия активна — говорите естественно" : "Сохраните агента и запустите сессию"}</p></div></div><span>24 kHz PCM</span></header><div className="test-dialog">{!messages.length ? <div className="test-empty"><div><Mic /></div><h3>{status === "live" ? "Я вас слушаю" : "Проверьте агента до подключения номера"}</h3><p>Можно говорить, перебивать агента или отправить текст.</p></div> : messages.map((message, index) => <div className={`test-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "Вы" : agent.name}</span><p>{message.text}</p></div>)}</div><footer><label className="tester-speaks-first"><input type="checkbox" checked={agent.speaksFirst} readOnly /> Агент говорит первым</label><div className="test-input"><input value={textInput} disabled={status !== "live"} onChange={(event) => setTextInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendText(); }} placeholder="Напишите или используйте микрофон" /><button disabled={status !== "live" || !textInput.trim()} onClick={sendText}>Отправить</button></div>{status === "live" ? <button className="stop-session" onClick={stop}><CircleStop size={17} /> Завершить сессию</button> : <button className="start-session" disabled={status === "connecting" || !agent.id} onClick={() => void start()}><Mic size={17} /> {status === "connecting" ? "Подключаем…" : "Запустить сессию"}</button>}</footer></aside>;
}
