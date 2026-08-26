import type { PoolClient, QueryResultRow } from "pg";
import { databaseQuery, databaseTransaction } from "./db.ts";
import { dispatchOutboundCall, OutboundCallError } from "./outbound.ts";
import { currentTenantId, withTenant } from "./tenant-context.ts";
import type { CampaignRecipientInput } from "./campaign-csv.ts";

export type CampaignStatus = "draft" | "running" | "paused" | "completed";
export type RecipientStatus = "pending" | "dispatching" | "dialing" | "completed" | "failed" | "skipped";

interface CampaignRow extends QueryResultRow {
  id: string;
  name: string;
  agent_id: string;
  connection_id: string;
  purpose_template: string;
  status: CampaignStatus;
  interval_seconds: number;
  next_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  total: string;
  pending: string;
  active: string;
  completed: string;
  failed: string;
}

interface RecipientRow extends QueryResultRow {
  id: string;
  position: number;
  phone: string;
  name: string;
  variables: unknown;
  status: RecipientStatus;
  call_id: string | null;
  error: string;
  attempts: number;
  created_at: Date | string;
  updated_at: Date | string;
  call_status: string | null;
}

const CAMPAIGN_SELECT = `c.id, c.name, c.agent_id, c.connection_id, c.purpose_template,
  c.status, c.interval_seconds, c.next_run_at, c.created_at, c.updated_at,
  c.started_at, c.completed_at,
  count(r.id)::text AS total,
  count(r.id) FILTER (WHERE r.status = 'pending')::text AS pending,
  count(r.id) FILTER (WHERE r.status IN ('dispatching', 'dialing'))::text AS active,
  count(r.id) FILTER (WHERE r.status = 'completed')::text AS completed,
  count(r.id) FILTER (WHERE r.status = 'failed')::text AS failed`;

function timestamp(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function campaignFromRow(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    connectionId: row.connection_id,
    purposeTemplate: row.purpose_template,
    status: row.status,
    intervalSeconds: row.interval_seconds,
    nextRunAt: timestamp(row.next_run_at),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
    counts: {
      total: Number(row.total), pending: Number(row.pending), active: Number(row.active),
      completed: Number(row.completed), failed: Number(row.failed),
    },
  };
}

function recipientFromRow(row: RecipientRow) {
  return {
    id: row.id,
    position: row.position,
    phone: row.phone,
    name: row.name,
    variables: record(row.variables),
    status: row.status,
    callId: row.call_id,
    callStatus: row.call_status,
    error: row.error,
    attempts: row.attempts,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

export async function createCampaign(input: {
  name: string;
  agentId: string;
  connectionId: string;
  purposeTemplate: string;
  intervalSeconds: number;
  recipients: CampaignRecipientInput[];
}) {
  const tenantId = currentTenantId();
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Укажите название кампании");
  if (!input.agentId.trim()) throw new Error("Выберите голосового агента");
  if (!input.connectionId.trim()) throw new Error("Выберите SIP-подключение");
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 86_400) {
    throw new Error("Интервал должен быть от 1 минуты до 24 часов");
  }
  if (!input.recipients.length || input.recipients.length > 5_000) throw new Error("Добавьте от 1 до 5000 контактов");
  const id = crypto.randomUUID();
  await databaseTransaction(async (client) => {
    const now = new Date();
    await client.query(
      `INSERT INTO ascn_call_campaigns
         (tenant_id, id, name, agent_id, connection_id, purpose_template, status,
          interval_seconds, next_run_at, created_at, updated_at, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, NULL, $8, $8, NULL, NULL)`,
      [tenantId, id, name, input.agentId.trim(), input.connectionId.trim(), input.purposeTemplate.trim().slice(0, 1000), input.intervalSeconds, now],
    );
    const payload = input.recipients.map((recipient, position) => ({
      id: crypto.randomUUID(), position, phone: recipient.phone, name: recipient.name,
      variables: recipient.variables,
    }));
    await client.query(
      `INSERT INTO ascn_call_campaign_recipients
         (tenant_id, campaign_id, id, position, phone, name, variables, status,
          call_id, error, attempts, created_at, updated_at)
       SELECT $1, $2, item.id, item.position, item.phone, item.name, item.variables,
              'pending', NULL, '', 0, $4, $4
       FROM jsonb_to_recordset($3::jsonb)
         AS item(id text, position integer, phone text, name text, variables jsonb)`,
      [tenantId, id, JSON.stringify(payload), now],
    );
  });
  return getCampaign(id);
}

export async function listCampaigns() {
  const tenantId = currentTenantId();
  const result = await databaseQuery<CampaignRow>(
    `SELECT ${CAMPAIGN_SELECT}
     FROM ascn_call_campaigns c
     LEFT JOIN ascn_call_campaign_recipients r
       ON r.tenant_id = c.tenant_id AND r.campaign_id = c.id
     WHERE c.tenant_id = $1
     GROUP BY c.tenant_id, c.id
     ORDER BY c.created_at DESC`,
    [tenantId],
  );
  return result.rows.map(campaignFromRow);
}

export async function getCampaign(id: string) {
  const tenantId = currentTenantId();
  const campaignResult = await databaseQuery<CampaignRow>(
    `SELECT ${CAMPAIGN_SELECT}
     FROM ascn_call_campaigns c
     LEFT JOIN ascn_call_campaign_recipients r
       ON r.tenant_id = c.tenant_id AND r.campaign_id = c.id
     WHERE c.tenant_id = $1 AND c.id = $2
     GROUP BY c.tenant_id, c.id`,
    [tenantId, id],
  );
  if (!campaignResult.rows[0]) return null;
  const recipientResult = await databaseQuery<RecipientRow>(
    `SELECT r.id, r.position, r.phone, r.name, r.variables, r.status, r.call_id,
            r.error, r.attempts, r.created_at, r.updated_at, calls.status AS call_status
     FROM ascn_call_campaign_recipients r
     LEFT JOIN ascn_call_records calls
       ON calls.tenant_id = r.tenant_id AND calls.id = r.call_id
     WHERE r.tenant_id = $1 AND r.campaign_id = $2
     ORDER BY r.position
     LIMIT 5000`,
    [tenantId, id],
  );
  return { ...campaignFromRow(campaignResult.rows[0]), recipients: recipientResult.rows.map(recipientFromRow) };
}

export async function updateCampaignState(id: string, action: "start" | "pause" | "resume" | "retry_failed") {
  const tenantId = currentTenantId();
  return databaseTransaction(async (client) => {
    const locked = await client.query<{ status: CampaignStatus }>(
      "SELECT status FROM ascn_call_campaigns WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, id],
    );
    if (!locked.rows[0]) return null;
    if (action === "pause") {
      await client.query(
        `UPDATE ascn_call_campaigns SET status = 'paused', next_run_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'`, [tenantId, id],
      );
    } else {
      if (action === "retry_failed") {
        await client.query(
          `UPDATE ascn_call_campaign_recipients
           SET status = 'pending', call_id = NULL, error = '', updated_at = now()
           WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'failed'`, [tenantId, id],
        );
      }
      const pending = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM ascn_call_campaign_recipients
         WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'pending') AS exists`, [tenantId, id],
      );
      if (!pending.rows[0]?.exists) throw new Error("В кампании нет номеров, ожидающих звонка");
      await client.query(
        `UPDATE ascn_call_campaigns
         SET status = 'running', next_run_at = now(), updated_at = now(),
             started_at = COALESCE(started_at, now()), completed_at = NULL
         WHERE tenant_id = $1 AND id = $2`, [tenantId, id],
      );
    }
    const result = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_SELECT}
       FROM ascn_call_campaigns c
       LEFT JOIN ascn_call_campaign_recipients r ON r.tenant_id = c.tenant_id AND r.campaign_id = c.id
       WHERE c.tenant_id = $1 AND c.id = $2 GROUP BY c.tenant_id, c.id`, [tenantId, id],
    );
    return campaignFromRow(result.rows[0]);
  });
}

export async function deleteCampaign(id: string) {
  const tenantId = currentTenantId();
  const result = await databaseQuery(
    `DELETE FROM ascn_call_campaigns
     WHERE tenant_id = $1 AND id = $2 AND status <> 'running'`, [tenantId, id],
  );
  return (result.rowCount || 0) > 0;
}

async function reconcileCampaignState(client: PoolClient) {
  await client.query(
    `UPDATE ascn_call_campaign_recipients recipient
     SET status = CASE WHEN call.status = 'ended' THEN 'completed' ELSE 'failed' END,
         error = CASE WHEN call.status = 'failed' THEN call.error ELSE recipient.error END,
         updated_at = now()
     FROM ascn_call_records call
     WHERE recipient.tenant_id = call.tenant_id AND recipient.call_id = call.id
       AND recipient.status IN ('dispatching', 'dialing') AND call.status IN ('ended', 'failed')`,
  );
  await client.query(
    `UPDATE ascn_call_campaign_recipients recipient
     SET status = 'dialing', updated_at = now()
     FROM ascn_call_records call
     WHERE recipient.tenant_id = call.tenant_id AND recipient.call_id = call.id
       AND recipient.status = 'dispatching' AND call.status IN ('queued', 'dialing', 'live')`,
  );
  await client.query(
    `UPDATE ascn_call_campaign_recipients
     SET status = 'pending', call_id = NULL,
         error = 'Предыдущая попытка запуска прервалась', updated_at = now()
     WHERE status = 'dispatching'
       AND updated_at < now() - interval '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM ascn_call_records call
         WHERE call.tenant_id = ascn_call_campaign_recipients.tenant_id
           AND call.id = ascn_call_campaign_recipients.call_id
       )`,
  );
  await client.query(
    `UPDATE ascn_call_campaigns campaign
     SET status = 'completed', next_run_at = NULL, completed_at = now(), updated_at = now()
     WHERE campaign.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM ascn_call_campaign_recipients recipient
         WHERE recipient.tenant_id = campaign.tenant_id AND recipient.campaign_id = campaign.id
           AND recipient.status IN ('pending', 'dispatching', 'dialing')
       )`,
  );
}

type ClaimedRecipient = {
  tenantId: string; campaignId: string; recipientId: string; callId: string; phone: string;
  agentId: string; connectionId: string; variables: Record<string, string>;
};

async function claimRecipient(): Promise<ClaimedRecipient | null> {
  return databaseTransaction(async (client) => {
    await reconcileCampaignState(client);
    const campaign = await client.query<{
      tenant_id: string; id: string; agent_id: string; connection_id: string; interval_seconds: number;
    }>(
      `SELECT campaign.tenant_id, campaign.id, campaign.agent_id, campaign.connection_id, campaign.interval_seconds
       FROM ascn_call_campaigns campaign
       WHERE campaign.status = 'running' AND campaign.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM ascn_call_campaign_recipients active
           WHERE active.tenant_id = campaign.tenant_id AND active.campaign_id = campaign.id
             AND active.status IN ('dispatching', 'dialing')
         )
       ORDER BY campaign.next_run_at, campaign.tenant_id, campaign.id
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const selected = campaign.rows[0];
    if (!selected) return null;
    const recipient = await client.query<{ id: string; phone: string; variables: unknown }>(
      `SELECT id, phone, variables FROM ascn_call_campaign_recipients
       WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'pending'
       ORDER BY position FOR UPDATE SKIP LOCKED LIMIT 1`, [selected.tenant_id, selected.id],
    );
    if (!recipient.rows[0]) {
      await client.query(
        `UPDATE ascn_call_campaigns SET next_run_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`, [selected.tenant_id, selected.id],
      );
      return null;
    }
    const callId = crypto.randomUUID();
    await client.query(
      `UPDATE ascn_call_campaign_recipients
       SET status = 'dispatching', call_id = $4, attempts = attempts + 1, error = '', updated_at = now()
       WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3`,
      [selected.tenant_id, selected.id, recipient.rows[0].id, callId],
    );
    await client.query(
      `UPDATE ascn_call_campaigns
       SET next_run_at = now() + ($3 * interval '1 second'), updated_at = now()
       WHERE tenant_id = $1 AND id = $2`, [selected.tenant_id, selected.id, selected.interval_seconds],
    );
    return {
      tenantId: selected.tenant_id, campaignId: selected.id, recipientId: recipient.rows[0].id,
      callId,
      phone: recipient.rows[0].phone, agentId: selected.agent_id, connectionId: selected.connection_id,
      variables: record(recipient.rows[0].variables),
    };
  });
}

async function finishClaim(claim: ClaimedRecipient, callId: string | null, error = "") {
  await databaseQuery(
    `UPDATE ascn_call_campaign_recipients
     SET status = $4, call_id = $5, error = $6, updated_at = now()
     WHERE tenant_id = $1 AND campaign_id = $2 AND id = $3 AND status = 'dispatching'`,
    [claim.tenantId, claim.campaignId, claim.recipientId, error ? "failed" : "dialing", callId, error.slice(0, 1000)],
  );
}

export async function runCampaignSchedulerSweep(maxDispatches = 10) {
  let dispatched = 0;
  for (let index = 0; index < maxDispatches; index += 1) {
    const claim = await claimRecipient();
    if (!claim) break;
    await withTenant(claim.tenantId, async () => {
      try {
        const call = await dispatchOutboundCall({
          callId: claim.callId, toNumber: claim.phone, agentId: claim.agentId,
          connectionId: claim.connectionId, variables: claim.variables,
        });
        await finishClaim(claim, call?.id || null);
        dispatched += 1;
      } catch (error) {
        const callId = error instanceof OutboundCallError ? error.call?.id || null : null;
        await finishClaim(claim, callId, error instanceof Error ? error.message : "Не удалось запустить звонок");
      }
    });
  }
  return dispatched;
}
