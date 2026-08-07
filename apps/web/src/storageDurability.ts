import type { DiagnosticsBuffer } from "./diagnostics.js";

/** The subset of navigator.storage used by the boot durability probe. Keeping
 * this structural makes the probe testable without a browser and lets older
 * browsers omit either method. */
export interface StorageDurabilityApi {
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<StorageEstimate>;
}

function record(diagnostics: DiagnosticsBuffer | undefined, kind: string, payload: unknown): void {
  try {
    diagnostics?.record(kind, payload);
  } catch {
    // Durability diagnostics are observational and must never block boot.
  }
}

/** Request best-effort browser storage durability and capture the quota
 * estimate. Browsers may deny persistence, and older browsers may expose no
 * StorageManager API at all; both cases are useful diagnostics, not boot
 * failures. Stable persistence/estimate facts are also placed in the
 * DiagnosticsContext so a noisy event ring cannot evict them before a report
 * is copied. */
export async function requestStorageDurability(
  storage: StorageDurabilityApi | undefined,
  diagnostics?: DiagnosticsBuffer,
): Promise<void> {
  diagnostics?.setStorageEstimateSource(storage);
  if (!storage) {
    record(diagnostics, "storage:durability-unavailable", {
      persist: false,
      estimate: false,
    });
    return;
  }

  if (typeof storage.persist === "function") {
    try {
      const persisted = await storage.persist();
      diagnostics?.setContext({ storagePersisted: persisted });
      record(diagnostics, "storage:persist", { persisted });
    } catch (error) {
      // A denied request is expected in some browser modes (private browsing,
      // user policy, or a non-installed site). Keep booting with best effort.
      record(diagnostics, "storage:persist-failed", { error });
    }
  } else {
    record(diagnostics, "storage:persist-unavailable", { persist: false });
  }

  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      diagnostics?.setContext({
        ...(typeof estimate.usage === "number" ? { storageUsage: estimate.usage } : {}),
        ...(typeof estimate.quota === "number" ? { storageQuota: estimate.quota } : {}),
      });
      record(diagnostics, "storage:estimate", {
        usage: estimate.usage,
        quota: estimate.quota,
      });
    } catch (error) {
      record(diagnostics, "storage:estimate-failed", { error });
    }
  } else {
    record(diagnostics, "storage:estimate-unavailable", { estimate: false });
  }
}
