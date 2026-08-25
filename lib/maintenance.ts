import { reconcileStaleCalls } from "./calls.ts";
import { ensureAsteriskConfiguration } from "./voice-agents.ts";

type MaintenanceGlobals = typeof globalThis & {
  __ascnMaintenanceReady?: Promise<void>;
  __ascnStaleCallTimer?: ReturnType<typeof setInterval>;
};

const maintenanceGlobals = globalThis as MaintenanceGlobals;

function intervalMilliseconds() {
  const parsed = Number.parseInt(process.env.STALE_CALL_RECONCILE_INTERVAL_MS || "", 10);
  return Number.isSafeInteger(parsed)
    ? Math.min(3_600_000, Math.max(60_000, parsed))
    : 300_000;
}

async function reconcileAndReport() {
  const reconciled = await reconcileStaleCalls();
  if (reconciled) console.warn(`Reconciled ${reconciled} stale voice call(s)`);
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
    })().catch((error) => {
      maintenanceGlobals.__ascnMaintenanceReady = undefined;
      throw error;
    });
  }
  return maintenanceGlobals.__ascnMaintenanceReady;
}
