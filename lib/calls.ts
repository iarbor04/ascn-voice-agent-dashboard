import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type Contact = { id: string; phone: string; name: string; language: string; status: string; lastMessage: string; updatedAt: string; unread: number; notes: string[] };
export type CallMessage = { id: string; contactId: string; direction: "inbound" | "outbound"; text: string; createdAt: string };
export type CallStatus = "queued" | "dialing" | "live" | "ended" | "failed";
export type CallOutcome = { resolved: boolean; summary: string; confirmation: string; operator: string; nextStep: string };
export type CallRecord = { id: string; direction: "inbound" | "outbound"; phone: string; agentId: string; agentName: string; provider: string; model: string; status: CallStatus; variables: Record<string, string>; error: string; outcome: CallOutcome | null; firstAudioMs: number; toolCalls: number; transfers: number; toolUsage: Record<string, number>; recordedSeconds: number; createdAt: string; updatedAt: string; endedAt: string };
type Store = { contacts: Contact[]; messages: CallMessage[]; calls: CallRecord[] };
const dataDirectory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".data");
const storePath = path.join(dataDirectory, "calls.json");
let queue = Promise.resolve();

async function readStore(): Promise<Store> {
  try { const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<Store>; return { contacts: parsed.contacts || [], messages: parsed.messages || [], calls: parsed.calls || [] }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { contacts: [], messages: [], calls: [] }; }
}
async function writeStore(store: Store) { await mkdir(dataDirectory, { recursive: true }); const temporary = `${storePath}.tmp`; await writeFile(temporary, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 }); await rename(temporary, storePath); }
function mutate<T>(operation: (store: Store) => T | Promise<T>) { const run = queue.catch(() => undefined).then(async () => { const store = await readStore(); const result = await operation(store); await writeStore(store); return result; }); queue = run.then(() => undefined, () => undefined); return run; }
function contactId(phone: string) { return `phone:${phone.trim() || "unknown"}`; }

export async function listContacts() { await queue; return (await readStore()).contacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
export async function getContact(id: string) { await queue; return (await readStore()).contacts.find((item) => item.id === id) || null; }
export async function listCallMessages(id: string) { await queue; return (await readStore()).messages.filter((item) => item.contactId === id); }
export function ensurePhoneContact(phone: string) { return mutate((store) => { const id = contactId(phone); let contact = store.contacts.find((item) => item.id === id); if (!contact) { const normalized = phone.trim() || "unknown"; contact = { id, phone: normalized, name: normalized === "unknown" ? "Неизвестный звонящий" : normalized, language: "Не определён", status: "new", lastMessage: "Входящий звонок", updatedAt: new Date().toISOString(), unread: 0, notes: [] }; store.contacts.push(contact); } return { ...contact, notes: [...contact.notes] }; }); }
export function saveCallTranscript(phone: string, direction: "inbound" | "outbound", text: string) { return mutate((store) => { const contact = store.contacts.find((item) => item.id === contactId(phone)); if (!contact) throw new Error("Контакт не найден"); const createdAt = new Date().toISOString(); const message = { id: crypto.randomUUID(), contactId: contact.id, direction, text, createdAt } satisfies CallMessage; store.messages.push(message); contact.lastMessage = text; contact.updatedAt = createdAt; if (direction === "inbound") contact.unread += 1; return message; }); }
export function updatePhoneContact(phone: string, changes: { name?: string; language?: string }) { return mutate((store) => { const contact = store.contacts.find((item) => item.id === contactId(phone)); if (!contact) return null; if (changes.name?.trim()) contact.name = changes.name.trim().slice(0, 120); if (changes.language?.trim()) contact.language = changes.language.trim().slice(0, 40); return { ...contact }; }); }
export function updateContactStatus(phone: string, status: string) { return mutate((store) => { const contact = store.contacts.find((item) => item.id === contactId(phone)); if (!contact) return false; contact.status = status.slice(0, 40); return true; }); }
export function rememberPhoneNote(phone: string, note: string) { return mutate((store) => { const contact = store.contacts.find((item) => item.id === contactId(phone)); if (!contact) return null; contact.notes = [...contact.notes, note.trim().slice(0, 1000)].filter(Boolean).slice(-30); return [...contact.notes]; }); }

export async function listCallRecords() { await queue; return (await readStore()).calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200); }
export async function getCallRecord(id: string) { await queue; return (await readStore()).calls.find((item) => item.id === id) || null; }
export async function listMessagesSince(id: string, since: string) { await queue; return (await readStore()).messages.filter((item) => item.contactId === id && item.createdAt >= since); }
export function createCallRecord(record: Omit<CallRecord, "status" | "error" | "outcome" | "firstAudioMs" | "toolCalls" | "transfers" | "toolUsage" | "recordedSeconds" | "createdAt" | "updatedAt" | "endedAt">) {
  return mutate((store) => {
    const now = new Date().toISOString();
    const call = { ...record, status: "queued" as CallStatus, error: "", outcome: null, firstAudioMs: 0, toolCalls: 0, transfers: 0, toolUsage: {}, recordedSeconds: 0, createdAt: now, updatedAt: now, endedAt: "" } satisfies CallRecord;
    store.calls = [...store.calls, call].slice(-500);
    return { ...call };
  });
}
export function recordCallMetric(id: string, metric: { firstAudioMs?: number; tool?: string; recordedSeconds?: number }) {
  return mutate((store) => {
    const call = store.calls.find((item) => item.id === id);
    if (!call) return null;
    if (metric.recordedSeconds) call.recordedSeconds = metric.recordedSeconds;
    if (metric.firstAudioMs && !call.firstAudioMs) call.firstAudioMs = Math.max(0, Math.round(metric.firstAudioMs));
    if (metric.tool) {
      call.toolCalls = (call.toolCalls || 0) + 1;
      // Считаем по именам: только так видно, какой инструмент реально работает.
      call.toolUsage = { ...(call.toolUsage || {}), [metric.tool]: ((call.toolUsage || {})[metric.tool] || 0) + 1 };
      if (metric.tool === "ascn_transfer_call") call.transfers = (call.transfers || 0) + 1;
    }
    call.updatedAt = new Date().toISOString();
    return { ...call };
  });
}

export function updateCallRecord(id: string, changes: Partial<Pick<CallRecord, "status" | "error" | "outcome" | "phone" | "endedAt">>) {
  return mutate((store) => {
    const call = store.calls.find((item) => item.id === id);
    if (!call) return null;
    Object.assign(call, changes, { updatedAt: new Date().toISOString() });
    if (changes.status === "ended" || changes.status === "failed") call.endedAt = call.endedAt || call.updatedAt;
    return { ...call };
  });
}
