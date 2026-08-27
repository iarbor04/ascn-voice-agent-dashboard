import type { PoolClient, QueryResultRow } from "pg";
import { databaseQuery, databaseTransaction } from "./db.ts";
import { currentTenantId } from "./tenant-context.ts";

export type Contact = { id: string; phone: string; name: string; language: string; status: string; lastMessage: string; updatedAt: string; unread: number; notes: string[] };
export type CallMessage = { id: string; contactId: string; callId: string | null; direction: "inbound" | "outbound"; text: string; createdAt: string };
export type CallStatus = "queued" | "dialing" | "live" | "ended" | "failed";
export type CallOutcome = { resolved: boolean; summary: string; confirmation: string; operator: string; nextStep: string };
// Итог выгрузки звонка во внешнюю систему. skipped значит «интеграция не
// настроена» — это не ошибка и повторять её нечего.
export type IntegrationStatus = { status: "sent" | "failed" | "skipped"; detail: string; entityId: string; at: string };
export type CallRecord = { id: string; direction: "inbound" | "outbound"; phone: string; agentId: string; agentName: string; provider: string; model: string; status: CallStatus; variables: Record<string, string>; error: string; outcome: CallOutcome | null; firstAudioMs: number; toolCalls: number; transfers: number; toolUsage: Record<string, number>; recordedSeconds: number; integrations: Record<string, IntegrationStatus>; createdAt: string; updatedAt: string; endedAt: string };

interface ContactRow extends QueryResultRow {
  id: string;
  phone: string;
  name: string;
  language: string;
  status: string;
  last_message: string;
  updated_at: Date | string;
  unread: number;
  notes: unknown;
}

interface MessageRow extends QueryResultRow {
  id: string;
  contact_id: string;
  call_id: string | null;
  direction: "inbound" | "outbound";
  text: string;
  created_at: Date | string;
}

interface CallRow extends QueryResultRow {
  id: string;
  direction: "inbound" | "outbound";
  phone: string;
  agent_id: string;
  agent_name: string;
  provider: string;
  model: string;
  status: CallStatus;
  variables: unknown;
  error: string;
  outcome: unknown;
  first_audio_ms: number;
  tool_calls: number;
  transfers: number;
  tool_usage: unknown;
  recorded_seconds: number;
  integrations: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  ended_at: Date | string | null;
}

const CONTACT_COLUMNS = "id, phone, name, language, status, last_message, updated_at, unread, notes";
const CALL_COLUMNS = `id, direction, phone, agent_id, agent_name, provider, model, status,
  variables, error, outcome, first_audio_ms, tool_calls, transfers, tool_usage,
  recorded_seconds, integrations, created_at, updated_at, ended_at`;

function isoTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function notes(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

function integrationStatuses(value: unknown): Record<string, IntegrationStatus> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(["sent", "failed", "skipped"]);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      const status = typeof item.status === "string" && allowed.has(item.status) ? item.status as IntegrationStatus["status"] : "failed";
      return [[key, {
        status,
        detail: typeof item.detail === "string" ? item.detail : "",
        entityId: typeof item.entityId === "string" ? item.entityId : "",
        at: typeof item.at === "string" ? item.at : "",
      }]] as Array<[string, IntegrationStatus]>;
    }),
  );
}

function outcome(value: unknown): CallOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    resolved: raw.resolved === true,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    confirmation: typeof raw.confirmation === "string" ? raw.confirmation : "",
    operator: typeof raw.operator === "string" ? raw.operator : "",
    nextStep: typeof raw.nextStep === "string" ? raw.nextStep : "",
  };
}

function contactFromRow(row: ContactRow): Contact {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    language: row.language,
    status: row.status,
    lastMessage: row.last_message,
    updatedAt: isoTimestamp(row.updated_at),
    unread: Number(row.unread) || 0,
    notes: [...notes(row.notes)],
  };
}

function messageFromRow(row: MessageRow): CallMessage {
  return {
    id: row.id,
    contactId: row.contact_id,
    callId: row.call_id || null,
    direction: row.direction,
    text: row.text,
    createdAt: isoTimestamp(row.created_at),
  };
}

function callFromRow(row: CallRow): CallRecord {
  return {
    id: row.id,
    direction: row.direction,
    phone: row.phone,
    agentId: row.agent_id,
    agentName: row.agent_name,
    provider: row.provider,
    model: row.model,
    status: row.status,
    variables: stringRecord(row.variables),
    error: row.error,
    outcome: outcome(row.outcome),
    firstAudioMs: Number(row.first_audio_ms) || 0,
    toolCalls: Number(row.tool_calls) || 0,
    transfers: Number(row.transfers) || 0,
    toolUsage: numberRecord(row.tool_usage),
    recordedSeconds: Number(row.recorded_seconds) || 0,
    integrations: integrationStatuses(row.integrations),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    endedAt: row.ended_at ? isoTimestamp(row.ended_at) : "",
  };
}

function contactId(phone: string) {
  return `phone:${phone.trim() || "unknown"}`;
}

async function lockedContact(client: PoolClient, tenantId: string, id: string) {
  return client.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS}
     FROM ascn_contacts
     WHERE tenant_id = $1 AND id = $2
     FOR UPDATE`,
    [tenantId, id],
  );
}

async function lockedCall(client: PoolClient, tenantId: string, id: string) {
  return client.query<CallRow>(
    `SELECT ${CALL_COLUMNS}
     FROM ascn_call_records
     WHERE tenant_id = $1 AND id = $2
     FOR UPDATE`,
    [tenantId, id],
  );
}

export async function listContacts() {
  const tenantId = currentTenantId();
  const result = await databaseQuery<ContactRow>(
    `SELECT ${CONTACT_COLUMNS}
     FROM ascn_contacts
     WHERE tenant_id = $1
     ORDER BY updated_at DESC, id ASC`,
    [tenantId],
  );
  return result.rows.map(contactFromRow);
}

export async function getContact(id: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery<ContactRow>(
    `SELECT ${CONTACT_COLUMNS}
     FROM ascn_contacts
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, id],
  );
  return result.rows[0] ? contactFromRow(result.rows[0]) : null;
}

export async function listCallMessages(id: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery<MessageRow>(
    `SELECT id, contact_id, call_id, direction, text, created_at
     FROM ascn_call_messages
     WHERE tenant_id = $1 AND contact_id = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, id],
  );
  return result.rows.map(messageFromRow);
}

export async function ensurePhoneContact(phone: string) {
  const tenantId = currentTenantId();
  const id = contactId(phone);
  const normalized = phone.trim() || "unknown";
  return databaseTransaction(async (client) => {
    await client.query(
      `INSERT INTO ascn_contacts
         (tenant_id, id, phone, name, language, status, last_message, updated_at, unread, notes)
       VALUES ($1, $2, $3, $4, 'Не определён', 'new', 'Входящий звонок', now(), 0, '[]'::jsonb)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [tenantId, id, normalized, normalized === "unknown" ? "Неизвестный звонящий" : normalized],
    );
    const result = await lockedContact(client, tenantId, id);
    return contactFromRow(result.rows[0]);
  });
}

export async function saveCallTranscript(phone: string, direction: "inbound" | "outbound", text: string, callId: string | null = null) {
  const tenantId = currentTenantId();
  const id = contactId(phone);
  return databaseTransaction(async (client) => {
    const contactResult = await lockedContact(client, tenantId, id);
    const contact = contactResult.rows[0];
    if (!contact) throw new Error("Контакт не найден");
    if (callId) {
      const callResult = await client.query<{ phone: string }>(
        `SELECT phone
         FROM ascn_call_records
         WHERE tenant_id = $1 AND id = $2
         FOR KEY SHARE`,
        [tenantId, callId],
      );
      if (!callResult.rows[0] || contactId(callResult.rows[0].phone) !== id) return null;
    }
    const createdAt = new Date();
    const messageId = crypto.randomUUID();
    const messageResult = await client.query<MessageRow>(
      `INSERT INTO ascn_call_messages (tenant_id, id, contact_id, call_id, direction, text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, contact_id, call_id, direction, text, created_at`,
      [tenantId, messageId, id, callId, direction, text, createdAt],
    );
    await client.query(
      `UPDATE ascn_contacts
       SET last_message = $3,
           updated_at = $4,
           unread = unread + CASE WHEN $5 = 'inbound' THEN 1 ELSE 0 END
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, text, createdAt, direction],
    );
    return messageFromRow(messageResult.rows[0]);
  });
}

export async function updatePhoneContact(phone: string, changes: { name?: string; language?: string }) {
  const tenantId = currentTenantId();
  const name = changes.name?.trim();
  const language = changes.language?.trim();
  const result = await databaseQuery<ContactRow>(
    `UPDATE ascn_contacts
     SET name = CASE WHEN $3::text IS NULL THEN name ELSE $3 END,
         language = CASE WHEN $4::text IS NULL THEN language ELSE $4 END
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${CONTACT_COLUMNS}`,
    [tenantId, contactId(phone), name ? name.slice(0, 120) : null, language ? language.slice(0, 40) : null],
  );
  return result.rows[0] ? contactFromRow(result.rows[0]) : null;
}

export async function updateContactStatus(phone: string, status: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery(
    `UPDATE ascn_contacts
     SET status = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, contactId(phone), status.slice(0, 40)],
  );
  return (result.rowCount || 0) > 0;
}

export async function rememberPhoneNote(phone: string, note: string) {
  const tenantId = currentTenantId();
  const id = contactId(phone);
  return databaseTransaction(async (client) => {
    const result = await lockedContact(client, tenantId, id);
    if (!result.rows[0]) return null;
    const cleanNote = note.trim().slice(0, 1000);
    const updatedNotes = [...notes(result.rows[0].notes).filter((existing) => existing !== cleanNote), cleanNote].filter(Boolean).slice(-30);
    await client.query(
      `UPDATE ascn_contacts SET notes = $3::jsonb WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, JSON.stringify(updatedNotes)],
    );
    return [...updatedNotes];
  });
}

export async function listCallRecords() {
  const tenantId = currentTenantId();
  const result = await databaseQuery<CallRow>(
    `SELECT ${CALL_COLUMNS}
     FROM ascn_call_records
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id ASC
     LIMIT 200`,
    [tenantId],
  );
  return result.rows.map(callFromRow);
}

export async function reconcileStaleCalls() {
  return databaseTransaction(async (client) => {
    // Every app replica runs the maintenance timer. A transaction-scoped leader
    // lock makes the global reconciliation cheap and single-writer without
    // leaving a session lock behind when a process crashes.
    const leader = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
      [401013, 4],
    );
    if (!leader.rows[0]?.acquired) return 0;
    const result = await client.query(
      `UPDATE ascn_call_records
       SET status = 'failed',
           error = CASE
             WHEN error = '' THEN 'Звонок прерван: gateway не подтвердил активное состояние'
             ELSE error
           END,
           updated_at = now(),
           ended_at = COALESCE(ended_at, now())
       WHERE (
         status IN ('queued', 'dialing')
         AND updated_at < now() - interval '10 minutes'
       ) OR (
         status = 'live'
         AND updated_at < now() - interval '3 hours'
       )`,
    );
    return result.rowCount || 0;
  });
}

export async function getCallRecord(id: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery<CallRow>(
    `SELECT ${CALL_COLUMNS}
     FROM ascn_call_records
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, id],
  );
  return result.rows[0] ? callFromRow(result.rows[0]) : null;
}

export async function listMessagesSince(id: string, since: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery<MessageRow>(
    `SELECT id, contact_id, call_id, direction, text, created_at
     FROM ascn_call_messages
     WHERE tenant_id = $1 AND contact_id = $2 AND created_at >= $3
     ORDER BY created_at ASC, id ASC`,
    [tenantId, id, since],
  );
  return result.rows.map(messageFromRow);
}

export async function listCallTranscript(callId: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery<MessageRow>(
    `SELECT id, contact_id, call_id, direction, text, created_at
     FROM ascn_call_messages
     WHERE tenant_id = $1 AND call_id = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, callId],
  );
  return result.rows.map(messageFromRow);
}

export async function createCallRecord(record: Omit<CallRecord, "status" | "error" | "outcome" | "firstAudioMs" | "toolCalls" | "transfers" | "toolUsage" | "recordedSeconds" | "integrations" | "createdAt" | "updatedAt" | "endedAt">) {
  const tenantId = currentTenantId();
  const now = new Date();
  const result = await databaseQuery<CallRow>(
    `INSERT INTO ascn_call_records
       (tenant_id, id, direction, phone, agent_id, agent_name, provider, model,
        status, variables, error, outcome, first_audio_ms, tool_calls, transfers,
        tool_usage, recorded_seconds, created_at, updated_at, ended_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8,
        'queued', $9::jsonb, '', NULL, 0, 0, 0, '{}'::jsonb, 0, $10, $10, NULL)
     RETURNING ${CALL_COLUMNS}`,
    [
      tenantId,
      record.id,
      record.direction,
      record.phone,
      record.agentId,
      record.agentName,
      record.provider,
      record.model,
      JSON.stringify(record.variables),
      now,
    ],
  );
  return callFromRow(result.rows[0]);
}

export async function recordCallMetric(id: string, metric: { firstAudioMs?: number; tool?: string; recordedSeconds?: number }) {
  const tenantId = currentTenantId();
  const tool = metric.tool || null;
  const firstAudioMs = metric.firstAudioMs ? Math.max(0, Math.round(metric.firstAudioMs)) : null;
  const recordedSeconds = metric.recordedSeconds ? Math.max(0, Math.round(metric.recordedSeconds)) : null;
  const result = await databaseQuery<CallRow>(
    `UPDATE ascn_call_records
     SET recorded_seconds = CASE WHEN $3::integer IS NULL THEN recorded_seconds ELSE $3 END,
         first_audio_ms = CASE
           WHEN $4::integer IS NOT NULL AND first_audio_ms = 0 THEN $4
           ELSE first_audio_ms
         END,
         tool_calls = tool_calls + CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
         tool_usage = CASE WHEN $5::text IS NULL THEN tool_usage ELSE
           jsonb_set(
             tool_usage,
             ARRAY[$5],
             to_jsonb(COALESCE((tool_usage ->> $5)::integer, 0) + 1),
             true
           )
         END,
         transfers = transfers + CASE WHEN $5 = 'ascn_transfer_call' THEN 1 ELSE 0 END,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${CALL_COLUMNS}`,
    [tenantId, id, recordedSeconds, firstAudioMs, tool],
  );
  return result.rows[0] ? callFromRow(result.rows[0]) : null;
}

export async function updateCallRecord(id: string, changes: Partial<Pick<CallRecord, "status" | "error" | "outcome" | "phone" | "endedAt">>) {
  const tenantId = currentTenantId();
  return databaseTransaction(async (client) => {
    const selected = await lockedCall(client, tenantId, id);
    if (!selected.rows[0]) return null;
    const call = callFromRow(selected.rows[0]);
    const transitions: Record<CallStatus, ReadonlySet<CallStatus>> = {
      queued: new Set(["queued", "dialing", "live", "ended", "failed"]),
      dialing: new Set(["dialing", "live", "ended", "failed"]),
      live: new Set(["live", "ended", "failed"]),
      ended: new Set(["ended"]),
      failed: new Set(["failed"]),
    };
    if (changes.status !== undefined && !transitions[call.status].has(changes.status)) return call;
    if (changes.status !== undefined) call.status = changes.status;
    if (changes.error !== undefined) call.error = changes.error;
    if (changes.outcome !== undefined) call.outcome = changes.outcome;
    if (changes.phone !== undefined) call.phone = changes.phone;
    if (changes.endedAt !== undefined) call.endedAt = changes.endedAt;
    call.updatedAt = new Date().toISOString();
    if (call.status === "ended" || call.status === "failed") call.endedAt = call.endedAt || call.updatedAt;

    const result = await client.query<CallRow>(
      `UPDATE ascn_call_records
       SET status = $3,
           error = $4,
           outcome = $5::jsonb,
           phone = $6,
           updated_at = $7,
           ended_at = $8
       WHERE tenant_id = $1 AND id = $2
       RETURNING ${CALL_COLUMNS}`,
      [
        tenantId,
        id,
        call.status,
        call.error,
        call.outcome ? JSON.stringify(call.outcome) : null,
        call.phone,
        call.updatedAt,
        call.endedAt || null,
      ],
    );
    return callFromRow(result.rows[0]);
  });
}

// Итог выгрузки пишем точечно через jsonb_set: адаптеры работают параллельно,
// и читать-менять-писать весь объект целиком означало бы терять чужой результат.
// updated_at не трогаем — выгрузка не является изменением самого звонка.
export async function recordIntegrationResult(id: string, destination: string, result: IntegrationStatus) {
  const tenantId = currentTenantId();
  const updated = await databaseQuery<CallRow>(
    `UPDATE ascn_call_records
     SET integrations = jsonb_set(COALESCE(integrations, '{}'::jsonb), ARRAY[$3], $4::jsonb, true)
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${CALL_COLUMNS}`,
    [tenantId, id, destination, JSON.stringify(result)],
  );
  return updated.rows[0] ? callFromRow(updated.rows[0]) : null;
}

export async function transitionCallToTerminal(id: string, status: "ended" | "failed", error = "") {
  const tenantId = currentTenantId();
  return databaseTransaction(async (client) => {
    const selected = await lockedCall(client, tenantId, id);
    if (!selected.rows[0]) return { call: null, changed: false };
    const current = callFromRow(selected.rows[0]);
    if (current.status === "ended" || current.status === "failed") {
      return { call: current, changed: false };
    }
    const updatedAt = new Date().toISOString();
    const result = await client.query<CallRow>(
      `UPDATE ascn_call_records
       SET status = $3,
           error = $4,
           updated_at = $5,
           ended_at = COALESCE(ended_at, $5)
       WHERE tenant_id = $1 AND id = $2
       RETURNING ${CALL_COLUMNS}`,
      [tenantId, id, status, error.slice(0, 500), updatedAt],
    );
    return { call: callFromRow(result.rows[0]), changed: true };
  });
}
