import { reconcileStaleCalls } from "./calls.ts";
import { runCampaignSchedulerSweep } from "./campaigns.ts";
import { ensureAsteriskConfiguration } from "./voice-agents.ts";

type MaintenanceGlobals = typeof globalThis & {
  __ascnMaintenanceReady?: Promise<void>;
  __ascnStaleCallTimer?: ReturnType<typeof setInterval>;
  __ascnCampaignTimer?: ReturnType<typeof setInterval>;
  __ascnCampaignSweep?: Promise<void>;
};

const maintenanceGlobals = globalThis as MaintenanceGlobals;

function intervalMilliseconds() {
  const parsed = Number.parseInt(process.env.STALE_CALL_RECONCILE_INTERVAL_MS || "", 10);
  return Number.isSafeInteger(parsed)
    ? Math.min(3_600_000, Math.max(60_000, parsed))
    : 300_000;
}

function campaignIntervalMilliseconds() {
  const parsed = Number.parseInt(process.env.CAMPAIGN_SCHEDULER_INTERVAL_MS || "", 10);
  return Number.isSafeInteger(parsed)
    ? Math.min(60_000, Math.max(5_000, parsed))
    : 15_000;
}

async function reconcileAndReport() {
  const reconciled = await reconcileStaleCalls();
  if (reconciled) console.warn(`Reconciled ${reconciled} stale voice call(s)`);
}

function runCampaignsAndReport() {
  if (!maintenanceGlobals.__ascnCampaignSweep) {
    maintenanceGlobals.__ascnCampaignSweep = runCampaignSchedulerSweep()
      .then((dispatched) => { if (dispatched) console.info(`Started ${dispatched} scheduled campaign call(s)`); })
      .catch((error) => { console.error("Campaign scheduler failed", error); })
      .finally(() => { maintenanceGlobals.__ascnCampaignSweep = undefined; });
  }
  return maintenanceGlobals.__ascnCampaignSweep;
}

/**
 * Runs once before the HTTP server accepts readiness probes. Asterisk config is
 * rendered from the migrated database at startup, while stale calls are then
 * reconciled on a bounded leader-elected timer instead of on public requests.
 */
export function startApplicationMaintenance() {
  if (!maintenanceGlobals.__ascnMaintenanceReady) {
    maintenanceGlobals.__ascnMaintenanceReady = (async () => {
      await ensureAsteriskConfiguration();
      await reconcileAndReport();
      if (!maintenanceGlobals.__ascnStaleCallTimer) {
        maintenanceGlobals.__ascnStaleCallTimer = setInterval(() => {
          void reconcileAndReport().catch((error) => {
            console.error("Stale call reconciliation failed", error);
          });
        }, intervalMilliseconds());
        maintenanceGlobals.__ascnStaleCallTimer.unref?.();
      }
      if (process.env.CAMPAIGN_SCHEDULER_ENABLED !== "false" && !maintenanceGlobals.__ascnCampaignTimer) {
        maintenanceGlobals.__ascnCampaignTimer = setInterval(() => {
          void runCampaignsAndReport();
        }, campaignIntervalMilliseconds());
        maintenanceGlobals.__ascnCampaignTimer.unref?.();
      }
    })().catch((error) => {
      maintenanceGlobals.__ascnMaintenanceReady = undefined;
      throw error;
    });
  }
  return maintenanceGlobals.__ascnMaintenanceReady;
}
