import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const MIGRATION_LOCK_NAMESPACE = 401013;
const MIGRATION_LOCK_ID = 1;

type DatabaseGlobals = typeof globalThis & {
  __ascnPostgresPool?: Pool;
  __ascnPostgresReady?: Promise<void>;
};

const databaseGlobals = globalThis as DatabaseGlobals;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function postgresPool() {
  if (databaseGlobals.__ascnPostgresPool) return databaseGlobals.__ascnPostgresPool;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL обязателен: JSON-хранилище больше не используется");
  }

  const ssl = /^(1|true|required)$/i.test(process.env.DATABASE_SSL?.trim() || "")
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined;
  const pool = new Pool({
    connectionString,
    ssl,
    max: boundedInteger(process.env.DATABASE_POOL_MAX, 10, 1, 100),
    idleTimeoutMillis: boundedInteger(process.env.DATABASE_IDLE_TIMEOUT_MS, 30_000, 1_000, 300_000),
    connectionTimeoutMillis: boundedInteger(process.env.DATABASE_CONNECT_TIMEOUT_MS, 10_000, 1_000, 60_000),
    application_name: "ascn-dashboard",
  });
  // A pool can emit errors for idle clients. Registering the handler prevents an
  // otherwise recoverable database disconnect from terminating the Node process.
  pool.on("error", (error) => console.error("PostgreSQL pool error", error));
  databaseGlobals.__ascnPostgresPool = pool;
  return pool;
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function migrateSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ascn_schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ascn_legacy_imports (
      source_path text PRIMARY KEY,
      content_sha256 char(64) NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      imported_rows jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS ascn_users (
      id text PRIMARY KEY,
      email text NOT NULL,
      password_hash text NOT NULL,
      salt text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ascn_users_email_unique
      ON ascn_users (lower(email));

    CREATE TABLE IF NOT EXISTS ascn_sessions (
      token_hash char(64) PRIMARY KEY,
      user_id text NOT NULL REFERENCES ascn_users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ascn_sessions_user_id_idx
      ON ascn_sessions (user_id);
    CREATE INDEX IF NOT EXISTS ascn_sessions_expires_at_idx
      ON ascn_sessions (expires_at);

    CREATE TABLE IF NOT EXISTS ascn_voice_stores (
      tenant_id text PRIMARY KEY,
      store jsonb NOT NULL CHECK (jsonb_typeof(store) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Version 5 splits the former per-tenant JSON blob. Settings remain one
    -- small row because they are changed atomically, while every agent gets an
    -- independent row so editing one large knowledge base does not rewrite all
    -- agents (or their secrets) for the tenant.
    CREATE TABLE IF NOT EXISTS ascn_voice_settings (
      tenant_id text PRIMARY KEY,
      settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ascn_voice_agents (
      tenant_id text NOT NULL,
      id text NOT NULL,
      agent jsonb NOT NULL CHECK (
        jsonb_typeof(agent) = 'object'
        AND agent ? 'id'
        AND agent ->> 'id' = id
      ),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS ascn_voice_agents_tenant_created_idx
      ON ascn_voice_agents (tenant_id, ((agent ->> 'createdAt')), id);

    CREATE TABLE IF NOT EXISTS ascn_contacts (
      tenant_id text NOT NULL,
      id text NOT NULL,
      phone text NOT NULL,
      name text NOT NULL,
      language text NOT NULL,
      status text NOT NULL,
      last_message text NOT NULL,
      updated_at timestamptz NOT NULL,
      unread integer NOT NULL DEFAULT 0 CHECK (unread >= 0),
      notes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array'),
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS ascn_contacts_tenant_updated_idx
      ON ascn_contacts (tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ascn_contacts_tenant_phone_idx
      ON ascn_contacts (tenant_id, phone);

    CREATE TABLE IF NOT EXISTS ascn_call_messages (
      tenant_id text NOT NULL,
      id text NOT NULL,
      contact_id text NOT NULL,
      call_id text,
      direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      text text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, contact_id)
        REFERENCES ascn_contacts(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ascn_call_messages_contact_created_idx
      ON ascn_call_messages (tenant_id, contact_id, created_at);

    CREATE TABLE IF NOT EXISTS ascn_call_records (
      tenant_id text NOT NULL,
      id text NOT NULL,
      direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      phone text NOT NULL,
      agent_id text NOT NULL,
      agent_name text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'dialing', 'live', 'ended', 'failed')),
      variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
      error text NOT NULL DEFAULT '',
      outcome jsonb,
      first_audio_ms integer NOT NULL DEFAULT 0 CHECK (first_audio_ms >= 0),
      tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
      transfers integer NOT NULL DEFAULT 0 CHECK (transfers >= 0),
      tool_usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tool_usage) = 'object'),
      recorded_seconds integer NOT NULL DEFAULT 0 CHECK (recorded_seconds >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      ended_at timestamptz,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS ascn_call_records_tenant_created_idx
      ON ascn_call_records (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ascn_call_records_active_idx
      ON ascn_call_records (tenant_id, updated_at)
      WHERE status IN ('queued', 'dialing', 'live');

    CREATE TABLE IF NOT EXISTS ascn_call_campaigns (
      tenant_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      agent_id text NOT NULL,
      connection_id text NOT NULL,
      purpose_template text NOT NULL DEFAULT '',
      status text NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed')),
      interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 86400),
      next_run_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      started_at timestamptz,
      completed_at timestamptz,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS ascn_call_campaigns_due_idx
      ON ascn_call_campaigns (next_run_at, tenant_id, id)
      WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS ascn_call_campaign_recipients (
      tenant_id text NOT NULL,
      campaign_id text NOT NULL,
      id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      phone text NOT NULL,
      name text NOT NULL DEFAULT '',
      variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
      status text NOT NULL CHECK (status IN ('pending', 'dispatching', 'dialing', 'completed', 'failed', 'skipped')),
      call_id text,
      error text NOT NULL DEFAULT '',
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, campaign_id, id),
      FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES ascn_call_campaigns(tenant_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ascn_call_campaign_recipients_position_idx
      ON ascn_call_campaign_recipients (tenant_id, campaign_id, position);
    CREATE INDEX IF NOT EXISTS ascn_call_campaign_recipients_pending_idx
      ON ascn_call_campaign_recipients (tenant_id, campaign_id, position)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS ascn_call_campaign_recipients_call_idx
      ON ascn_call_campaign_recipients (tenant_id, call_id)
      WHERE call_id IS NOT NULL;

    ALTER TABLE ascn_call_messages
      ADD COLUMN IF NOT EXISTS call_id text;
    CREATE INDEX IF NOT EXISTS ascn_call_messages_call_created_idx
      ON ascn_call_messages (tenant_id, call_id, created_at, id)
      WHERE call_id IS NOT NULL;
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ascn_call_messages_call_fk'
          AND conrelid = 'ascn_call_messages'::regclass
      ) THEN
        ALTER TABLE ascn_call_messages
          ADD CONSTRAINT ascn_call_messages_call_fk
          FOREIGN KEY (tenant_id, call_id)
          REFERENCES ascn_call_records(tenant_id, id);
      END IF;
    END
    $migration$;

    -- Legacy JSON stored bearer tokens in clear text. A one-time migration
    -- deliberately invalidates them instead of carrying compromised sessions
    -- into PostgreSQL.
    WITH newly_applied AS (
      INSERT INTO ascn_schema_migrations (version)
      VALUES (4)
      ON CONFLICT (version) DO NOTHING
      RETURNING version
    )
    DELETE FROM ascn_sessions
    WHERE EXISTS (SELECT 1 FROM newly_applied);

    INSERT INTO ascn_schema_migrations (version)
    VALUES (1), (2), (3), (4), (6)
    ON CONFLICT (version) DO NOTHING;
  `);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringObject(value: unknown) {
  return Object.fromEntries(
    Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function numberObject(value: unknown) {
  return Object.fromEntries(
    Object.entries(object(value)).flatMap(([key, raw]) => {
      const value = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(value) ? [[key, Math.max(0, Math.round(value))]] : [];
    }),
  );
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function timestamp(value: unknown, fallback = new Date(0).toISOString()) {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

async function legacyFile(pathname: string) {
  try {
    const contents = await readFile(pathname, "utf8");
    return {
      contents,
      hash: createHash("sha256").update(contents, "utf8").digest("hex"),
      parsed: object(JSON.parse(contents)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Не удалось прочитать legacy-хранилище ${pathname}`, { cause: error });
  }
}

async function wasImported(client: PoolClient, sourcePath: string, hash: string) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM ascn_legacy_imports
       WHERE source_path = $1 AND content_sha256 = $2
     ) AS exists`,
    [sourcePath, hash],
  );
  return result.rows[0]?.exists === true;
}

async function finishImport(client: PoolClient, sourcePath: string, hash: string, counts: Record<string, number>) {
  await client.query(
    `INSERT INTO ascn_legacy_imports (source_path, content_sha256, imported_at, imported_rows)
     VALUES ($1, $2, now(), $3::jsonb)
     ON CONFLICT (source_path) DO UPDATE SET
       content_sha256 = EXCLUDED.content_sha256,
       imported_at = EXCLUDED.imported_at,
       imported_rows = EXCLUDED.imported_rows`,
    [sourcePath, hash, JSON.stringify(counts)],
  );
}

async function importLegacyUsers(client: PoolClient, pathname: string) {
  const file = await legacyFile(pathname);
  if (!file || await wasImported(client, pathname, file.hash)) return;
  let users = 0;
  const sessions = 0;

  for (const raw of array(file.parsed.users)) {
    const user = object(raw);
    const id = string(user.id);
    const email = string(user.email).trim().toLowerCase();
    const passwordHash = string(user.passwordHash);
    const salt = string(user.salt);
    if (!id || !email || !passwordHash || !salt) continue;
    const result = await client.query(
      `INSERT INTO ascn_users (id, email, password_hash, salt, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [id, email, passwordHash, salt, timestamp(user.createdAt)],
    );
    users += result.rowCount || 0;
  }

  await finishImport(client, pathname, file.hash, { users, sessions });
}

function normalizedDirection(value: unknown): "inbound" | "outbound" {
  return value === "outbound" ? "outbound" : "inbound";
}

function normalizedStatus(value: unknown) {
  return ["queued", "dialing", "live", "ended", "failed"].includes(string(value)) ? string(value) : "ended";
}

async function importLegacyCalls(client: PoolClient, pathname: string, tenantId: string) {
  const file = await legacyFile(pathname);
  if (!file || await wasImported(client, pathname, file.hash)) return;
  let contacts = 0;
  let messages = 0;
  let calls = 0;

  for (const raw of array(file.parsed.contacts)) {
    const contact = object(raw);
    const id = string(contact.id);
    if (!id) continue;
    const notes = array(contact.notes).filter((note): note is string => typeof note === "string").slice(-30);
    const result = await client.query(
      `INSERT INTO ascn_contacts
         (tenant_id, id, phone, name, language, status, last_message, updated_at, unread, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        id,
        string(contact.phone, "unknown"),
        string(contact.name),
        string(contact.language),
        string(contact.status, "new"),
        string(contact.lastMessage),
        timestamp(contact.updatedAt),
        nonNegativeInteger(contact.unread),
        JSON.stringify(notes),
      ],
    );
    contacts += result.rowCount || 0;
  }

  for (const raw of array(file.parsed.messages)) {
    const message = object(raw);
    const id = string(message.id);
    const contactId = string(message.contactId);
    if (!id || !contactId) continue;
    const result = await client.query(
      `INSERT INTO ascn_call_messages (tenant_id, id, contact_id, direction, text, created_at)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE EXISTS (
         SELECT 1 FROM ascn_contacts WHERE tenant_id = $1 AND id = $3
       )
       ON CONFLICT DO NOTHING`,
      [tenantId, id, contactId, normalizedDirection(message.direction), string(message.text), timestamp(message.createdAt)],
    );
    messages += result.rowCount || 0;
  }

  for (const raw of array(file.parsed.calls)) {
    const call = object(raw);
    const id = string(call.id);
    if (!id) continue;
    const endedAt = string(call.endedAt);
    const result = await client.query(
      `INSERT INTO ascn_call_records
         (tenant_id, id, direction, phone, agent_id, agent_name, provider, model,
          status, variables, error, outcome, first_audio_ms, tool_calls, transfers,
          tool_usage, recorded_seconds, created_at, updated_at, ended_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb,
          $13, $14, $15, $16::jsonb, $17, $18, $19, $20)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        id,
        normalizedDirection(call.direction),
        string(call.phone),
        string(call.agentId),
        string(call.agentName),
        string(call.provider),
        string(call.model),
        normalizedStatus(call.status),
        JSON.stringify(stringObject(call.variables)),
        string(call.error),
        call.outcome && typeof call.outcome === "object" ? JSON.stringify(call.outcome) : null,
        nonNegativeInteger(call.firstAudioMs),
        nonNegativeInteger(call.toolCalls),
        nonNegativeInteger(call.transfers),
        JSON.stringify(numberObject(call.toolUsage)),
        nonNegativeInteger(call.recordedSeconds),
        timestamp(call.createdAt),
        timestamp(call.updatedAt, timestamp(call.createdAt)),
        endedAt && Number.isFinite(Date.parse(endedAt)) ? new Date(endedAt).toISOString() : null,
      ],
    );
    calls += result.rowCount || 0;
  }

  await finishImport(client, pathname, file.hash, { contacts, messages, calls });
}

async function importLegacyVoiceStore(client: PoolClient, pathname: string, tenantId: string) {
  const file = await legacyFile(pathname);
  if (!file || await wasImported(client, pathname, file.hash)) return;
  const normalized = await client.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM ascn_voice_settings WHERE tenant_id = $1) AS exists",
    [tenantId],
  );
  // Once a tenant has crossed the cut-over, a later edit to the mounted legacy
  // file must not resurrect deleted agents or duplicate raw secrets. Record the
  // new hash as observed, but keep PostgreSQL authoritative.
  if (normalized.rows[0]?.exists) {
    await finishImport(client, pathname, file.hash, { voiceStores: 0, normalizedAlready: 1 });
    return;
  }
  const result = await client.query(
    `INSERT INTO ascn_voice_stores (tenant_id, store, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, JSON.stringify(file.parsed)],
  );
  await finishImport(client, pathname, file.hash, { voiceStores: result.rowCount || 0 });
}

async function importLegacyData(client: PoolClient) {
  const configuredRoot = process.env.LEGACY_DATA_DIR?.trim() || process.env.DATA_DIR?.trim();
  const root = configuredRoot || path.join(process.cwd(), ".data");
  await importLegacyUsers(client, path.join(root, "users.json"));
  await importLegacyCalls(client, path.join(root, "calls.json"), "default");
  await importLegacyVoiceStore(client, path.join(root, "voice-agents.json"), "default");

  const tenantsRoot = path.join(root, "tenants");
  let tenantDirectories;
  try {
    tenantDirectories = await readdir(tenantsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of tenantDirectories) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    await importLegacyCalls(client, path.join(tenantsRoot, entry.name, "calls.json"), entry.name);
    await importLegacyVoiceStore(client, path.join(tenantsRoot, entry.name, "voice-agents.json"), entry.name);
  }
}

async function transferLegacyVoiceStores(client: PoolClient) {
  const result = await client.query<{ tenant_id: string; store: unknown }>(
    "SELECT tenant_id, store FROM ascn_voice_stores ORDER BY tenant_id FOR UPDATE",
  );
  for (const row of result.rows) {
    const store = object(row.store);
    const settings = object(store.settings);
    const agents = new Map<string, Record<string, unknown>>();
    for (const raw of array(store.agents)) {
      const agent = object(raw);
      const id = string(agent.id);
      if (!id) throw new Error(`Legacy voice store ${row.tenant_id} contains an agent without an id`);
      // Duplicate ids were ambiguous in the old array (`find` always selected
      // the first). Preserve that effective value deterministically.
      if (!agents.has(id)) agents.set(id, agent);
    }

    await client.query(
      `INSERT INTO ascn_voice_settings (tenant_id, settings, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [row.tenant_id, JSON.stringify(settings)],
    );
    for (const [id, agent] of agents) {
      await client.query(
        `INSERT INTO ascn_voice_agents (tenant_id, id, agent, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [row.tenant_id, id, JSON.stringify(agent), timestamp(agent.updatedAt, new Date().toISOString())],
      );
    }

    const verifiedSettings = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM ascn_voice_settings WHERE tenant_id = $1) AS exists",
      [row.tenant_id],
    );
    if (!verifiedSettings.rows[0]?.exists) throw new Error(`Voice settings transfer failed for ${row.tenant_id}`);
    if (agents.size) {
      const verifiedAgents = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ascn_voice_agents WHERE tenant_id = $1 AND id = ANY($2::text[])",
        [row.tenant_id, [...agents.keys()]],
      );
      if (Number(verifiedAgents.rows[0]?.count) !== agents.size) {
        throw new Error(`Voice agent transfer failed for ${row.tenant_id}`);
      }
    }

    // Delete only after both normalized destinations have been verified. This
    // removes the second raw copy of provider/SIP/tool secrets from PostgreSQL.
    await client.query("DELETE FROM ascn_voice_stores WHERE tenant_id = $1", [row.tenant_id]);
  }
  await client.query(
    "INSERT INTO ascn_schema_migrations (version) VALUES (5) ON CONFLICT (version) DO NOTHING",
  );
}

async function initialize(pool: Pool) {
  const client = await pool.connect();
  let locked = false;
  try {
    if (/^(1|true|yes)$/i.test(process.env.DATABASE_SCHEMA_MANAGED?.trim() || "")) {
      await client.query("SELECT 1");
      return;
    }
    await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
    locked = true;
    await client.query("BEGIN");
    await migrateSchema(client);
    await importLegacyData(client);
    await transferLegacyVoiceStores(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]).catch(() => undefined);
    }
    client.release();
  }
}

async function readyPool() {
  const pool = postgresPool();
  if (!databaseGlobals.__ascnPostgresReady) {
    const ready = initialize(pool).catch((error) => {
      databaseGlobals.__ascnPostgresReady = undefined;
      throw error;
    });
    databaseGlobals.__ascnPostgresReady = ready;
  }
  await databaseGlobals.__ascnPostgresReady;
  return pool;
}

export async function databaseQuery<Row extends QueryResultRow = QueryResultRow>(query: string, values: unknown[] = []) {
  const pool = await readyPool();
  return pool.query<Row>(query, values);
}

export async function databaseTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const pool = await readyPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabasePool() {
  const pool = databaseGlobals.__ascnPostgresPool;
  databaseGlobals.__ascnPostgresPool = undefined;
  databaseGlobals.__ascnPostgresReady = undefined;
  if (pool) await pool.end();
}
