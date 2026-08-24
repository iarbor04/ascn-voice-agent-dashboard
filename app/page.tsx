"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { BarChart3, Bot, PhoneCall, PhoneOutgoing, X } from "lucide-react";
import VoiceAgents from "@/app/voice-agents";
import InsightsView from "@/app/insights";

type View = "agents" | "calls" | "insights";
type Contact = { id: string; phone: string; name: string; language: string; status: string; lastMessage: string; updatedAt: string; unread: number };
type Message = { id: string; direction: "inbound" | "outbound"; text: string; createdAt: string };
type CallOutcome = { resolved: boolean; summary: string; confirmation: string; operator: string; nextStep: string };
type CallRecord = { id: string; direction: "inbound" | "outbound"; phone: string; agentName: string; status: string; error: string; outcome: CallOutcome | null; toolCalls: number; recordedSeconds: number; createdAt: string; endedAt: string; variables: Record<string, string> };
type AgentOption = { id: string; name: string; active: boolean };

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

const statusLabels: Record<string, string> = { queued: "В очереди", dialing: "Набираем", live: "Идёт разговор", ended: "Завершён", failed: "Ошибка" };

export default function Home() {
  const [view, setView] = useState<View>("agents");
  const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); }, []);
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Image className="brand-emblem" src="/emblem.svg" width={36} height={36} alt="ASCN.AI" priority /><span>ASCN.AI Voice</span></div>
      <nav className="main-nav"><p>ГОЛОСОВАЯ ПЛАТФОРМА</p><button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}><Bot className="nav-icon" />Голосовые агенты</button><button className={view === "calls" ? "active" : ""} onClick={() => setView("calls")}><PhoneCall className="nav-icon" />Звонки</button><button className={view === "insights" ? "active" : ""} onClick={() => setView("insights")}><BarChart3 className="nav-icon" />Аналитика</button></nav>
    </aside>
    <section className="workspace"><header className="topbar"><div className="breadcrumbs"><span>Голосовой проект</span><i>/</i><strong>{view === "agents" ? "Голосовые агенты" : view === "calls" ? "Звонки" : "Аналитика"}</strong></div></header><div className="content">{view === "agents" ? <VoiceAgents notify={notify} /> : view === "calls" ? <Calls notify={notify} /> : <InsightsView />}</div></section>
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}

function Calls({ notify }: { notify: (message: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [filters, setFilters] = useState({ id: "", minSeconds: "", from: "", to: "" });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialer, setDialer] = useState(false);
  const [calling, setCalling] = useState(false);
  const [form, setForm] = useState({ agentId: "", toNumber: "", callerName: "", callerPurpose: "" });

  const loadCalls = useCallback(() => fetch("/api/voice/calls").then((response) => response.json()).then((data) => setCalls(data.calls || [])).catch(() => undefined), []);
  const loadContacts = useCallback(() => fetch("/api/calls").then((response) => response.json()).then((data) => setContacts(data.contacts || [])).catch(() => notify("Не удалось загрузить звонки")), [notify]);
  const refresh = useCallback(() => Promise.all([loadContacts(), loadCalls()]).finally(() => setLoading(false)), [loadContacts, loadCalls]);

  useEffect(() => {
    void refresh();
    fetch("/api/voice/agents").then((response) => response.json()).then((data) => setAgents(data.agents || [])).catch(() => undefined);
  }, [refresh]);

  const busy = calls.some((call) => call.status === "queued" || call.status === "dialing" || call.status === "live");
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  const activeId = selected || contacts[0]?.id || "";
  const contact = contacts.find((item) => item.id === activeId);
  const visible = calls.filter((call) => {
    if (filters.id && !call.id.toLowerCase().includes(filters.id.trim().toLowerCase())) return false;
    if (filters.minSeconds && callSeconds(call) < Number(filters.minSeconds)) return false;
    if (filters.from && call.createdAt.slice(0, 10) < filters.from) return false;
    if (filters.to && call.createdAt.slice(0, 10) > filters.to) return false;
    return true;
  });
  useEffect(() => { if (!activeId) return; fetch(`/api/calls/${encodeURIComponent(activeId)}/messages`).then((response) => response.json()).then((data) => setMessages(data.messages || [])).catch(() => setMessages([])); }, [activeId, calls]);

  async function startCall() {
    setCalling(true);
    try {
      const response = await fetch("/api/voice/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: form.agentId || undefined, toNumber: form.toNumber, variables: { caller_name: form.callerName, caller_purpose: form.callerPurpose } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось начать звонок");
      notify("Звонок начат");
      setDialer(false);
      setForm({ agentId: form.agentId, toNumber: "", callerName: "", callerPurpose: "" });
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не удалось начать звонок");
      await loadCalls();
    } finally {
      setCalling(false);
    }
  }

  return <>
    <div className="page-header">
      <div><h1>Звонки</h1><p>Входящие и исходящие звонки, расшифровки и итоги сохраняются автоматически.</p></div>
      <button className="primary-button" onClick={() => setDialer((current) => !current)}>{dialer ? <X size={16} /> : <PhoneOutgoing size={16} />} {dialer ? "Отмена" : "Позвонить"}</button>
    </div>
    {dialer && <section className="call-launcher">
      <div className="processing-grid">
        <label>Агент<select value={form.agentId} onChange={(event) => setForm({ ...form, agentId: event.target.value })}><option value="">Активный по умолчанию</option>{agents.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " (выключен)"}</option>)}</select></label>
        <label>Кому звоним<input value={form.toNumber} onChange={(event) => setForm({ ...form, toNumber: event.target.value })} placeholder="+79001234567" /></label>
        <label>Название или имя<input value={form.callerName} onChange={(event) => setForm({ ...form, callerName: event.target.value })} placeholder="Клиника на Ленина" /></label>
        <label className="wide">Задача звонка<textarea rows={3} value={form.callerPurpose} onChange={(event) => setForm({ ...form, callerPurpose: event.target.value })} placeholder="Перенести приём с четверга на пятницу после 17:00, узнать номер записи" /></label>
      </div>
      <footer><small>Переменные <code>{"{{caller_name}}"}</code> и <code>{"{{caller_purpose}}"}</code> подставятся в промпт этого звонка.</small><button className="primary-button" disabled={calling || !form.toNumber.trim()} onClick={() => void startCall()}>{calling ? "Набираем…" : "Начать звонок"}</button></footer>
    </section>}
    {calls.length > 0 && <section className="call-filters">
      <label>ID звонка<input value={filters.id} onChange={(event) => setFilters({ ...filters, id: event.target.value })} placeholder="часть идентификатора" /></label>
      <label>Дольше, сек<input value={filters.minSeconds} onChange={(event) => setFilters({ ...filters, minSeconds: event.target.value.replace(/[^0-9]/g, "") })} placeholder="0" /></label>
      <label>С даты<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
      <label>По дату<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
      <small>{visible.length} из {calls.length}</small>
      {(filters.id || filters.minSeconds || filters.from || filters.to) && <button className="ghost-button" onClick={() => setFilters({ id: "", minSeconds: "", from: "", to: "" })}>Сбросить</button>}
    </section>}
    {visible.length > 0 && <section className="call-records">{visible.slice(0, 30).map((call) => <article key={call.id} className={call.status}>
      <header><span className={`call-status ${call.status}`}>{statusLabels[call.status] || call.status}</span><strong>{call.phone}</strong><small>{call.direction === "outbound" ? "исходящий" : "входящий"}{call.agentName ? ` · ${call.agentName}` : ""}</small><span className="call-meta">{callDuration(call)}{call.toolCalls ? ` · ${call.toolCalls} инстр.` : ""}</span><time>{new Date(call.createdAt).toLocaleString("ru-RU")}</time></header>
      {call.variables?.caller_purpose && <p className="call-purpose">{call.variables.caller_purpose}</p>}
      {/* Субтитров у записи нет: расшифровка разговора лежит рядом отдельным блоком. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      {call.recordedSeconds > 0 && <audio className="call-audio" controls preload="none" src={`/api/voice/recordings/${call.id}`} />}
      {call.error && <p className="call-error">{call.error}</p>}
      {call.outcome && <div className="call-outcome"><strong>{call.outcome.resolved ? "Задача выполнена" : "Задача не закрыта"}</strong>{call.outcome.summary && <p>{call.outcome.summary}</p>}<dl>{call.outcome.confirmation && <><dt>Подтверждение</dt><dd>{call.outcome.confirmation}</dd></>}{call.outcome.operator && <><dt>Сотрудник</dt><dd>{call.outcome.operator}</dd></>}{call.outcome.nextStep && <><dt>Дальше</dt><dd>{call.outcome.nextStep}</dd></>}</dl></div>}
    </article>)}</section>}
    {loading ? <div className="voice-loading">Загружаем звонки…</div> : !contacts.length ? <section className="empty-state"><div className="add-circle"><PhoneCall size={21} /></div><h2>Разговоров пока нет</h2><p>После первого звонка здесь появится контакт и полная расшифровка диалога.</p><button className="primary-button" onClick={() => void refresh()}>Обновить</button></section> : <div className="calls-layout">
      <section className="calls-list">{contacts.map((item) => <button key={item.id} className={activeId === item.id ? "selected" : ""} onClick={() => setSelected(item.id)}><span className="call-avatar"><PhoneCall size={16} /></span><div><strong>{item.name}</strong><small>{item.phone}</small><p>{item.lastMessage}</p></div><time>{new Date(item.updatedAt).toLocaleString("ru-RU")}</time></button>)}</section>
      <section className="call-transcript"><header><div className="call-avatar large"><PhoneCall size={18} /></div><div><h2>{contact?.name}</h2><p>{contact?.phone} · {contact?.language}</p></div></header><div>{messages.map((message) => <article className={message.direction} key={message.id}><span>{message.direction === "inbound" ? "Клиент" : "AI-агент"}</span><p>{message.text}</p><time>{new Date(message.createdAt).toLocaleString("ru-RU")}</time></article>)}</div></section>
    </div>}
  </>;
}
