import type { HostKv } from "./types.js";

/**
 * A synchronous view over an async {@link HostKv}, produced by loading the
 * whole key space into memory once at boot and writing back asynchronously.
 *
 * Why this exists: fen core calls its kv-backed seams synchronously —
 * `fen_web.sessions.kv_session` and the `fs_kv` shim
 * (docs/platform/shims.md) both assume `get`/`put`/`delete`/`list` return
 * a value, not a Promise, and the sessions register even asserts a
 * `sync = true` capability flag. wasmoon cannot await a JS promise from
 * inside a Lua coroutine, so the raw Promise-based `IndexedDbKv` cannot
 * back those call sites directly. docs/platform/shims.md notes a
 * coroutine-pumped streaming bridge as the eventual general answer; a
 * single-page app has a simpler option that needs no bridge: mirror the
 * store in memory.
 *
 * Reads are served from the in-memory map. Writes update the map
 * synchronously (so the VM sees its own writes immediately) and are queued to
 * the backing async kv; {@link SyncKvCache.flush} awaits the queue so
 * callers/tests can confirm durability. Write-back errors are captured and
 * surfaced on flush, and failed keys remain sticky until the current
 * in-memory value is successfully written or deleted from the backing store.
 *
 * Scope: fine for the demo's single-page, single-VM lifetime (one writer,
 * one tab). It is NOT a general multi-tab-coherent store — a second tab's
 * writes are not observed until reload. When that matters, replace this
 * with the streaming coroutine bridge shims.md describes; the `sync = true`
 * contract this satisfies is the same either way.
 */
export interface SyncKv {
  readonly sync: true;
  get(key: string): string | undefined;
  put(key: string, value: string): void;
  delete(key: string): void;
  /** Keys with `prefix`, ascending lexicographic order (empty = all). */
  list(prefix: string): string[];
}

export class SyncKvCache implements SyncKv {
  readonly sync = true as const;

  private constructor(
    private readonly store: Map<string, string>,
    private readonly backing: HostKv,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Track in-flight write-backs so {@link flush} can await them and so a
   * failed write surfaces instead of vanishing. */
  private pending = new Set<Promise<void>>();
  /** Keys whose latest desired value is not known to be durable. */
  private readonly failedKeys = new Set<string>();
  private readonly failedErrors = new Map<string, unknown>();
  private readonly writeGenerations = new Map<string, number>();

  /**
   * Load every key/value from `backing` into memory and return a
   * synchronous view. `onError` (default: rethrow on next flush) observes
   * async write-back failures.
   */
  static async load(
    backing: HostKv,
    onError?: (err: unknown) => void,
  ): Promise<SyncKvCache> {
    const keys = await backing.list("");
    const store = new Map<string, string>();
    for (const key of keys) {
      const value = await backing.get(key);
      if (value !== undefined) store.set(key, value);
    }
    return new SyncKvCache(store, backing, onError ?? (() => {}));
  }

  private nextGeneration(key: string): number {
    const generation = (this.writeGenerations.get(key) ?? 0) + 1;
    this.writeGenerations.set(key, generation);
    return generation;
  }

  private desiredWrite(key: string): Promise<void> {
    return this.store.has(key)
      ? this.backing.put(key, this.store.get(key) as string)
      : this.backing.delete(key);
  }

  /** Queue one write and keep its failure associated with the key's latest
   * desired state. Older operations cannot clear a newer failed state. */
  private track(key: string, generation: number, op: () => Promise<void>): void {
    const wrapped = Promise.resolve()
      .then(op)
      .then(
        () => {
          if (this.writeGenerations.get(key) === generation) {
            this.failedKeys.delete(key);
            this.failedErrors.delete(key);
            // The generation guard is only needed while ops for this key can
            // still be in flight; once the latest op committed, drop the
            // entry so the map is O(failed + in-flight), not O(keys ever
            // written) over a long session.
            this.writeGenerations.delete(key);
          }
        },
        (err: unknown) => {
          // A stale operation may fail after a newer operation has already
          // committed. It is still reported immediately, but only the latest
          // desired state can make the cache durable/undurable.
          if (this.writeGenerations.get(key) === generation) {
            this.failedKeys.add(key);
            this.failedErrors.set(key, err);
          }
          // The callback is an observation seam and must never replace the
          // storage error or turn a handled write failure into an unhandled
          // rejection.
          try {
            this.onError(err);
          } catch {
            // UI/diagnostics reporting is best effort.
          }
        },
      )
      .finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  private waitForPending(): Promise<void> {
    return Promise.all([...this.pending]).then(() => undefined);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  put(key: string, value: string): void {
    this.store.set(key, value);
    const generation = this.nextGeneration(key);
    this.track(key, generation, () => this.backing.put(key, value));
  }

  delete(key: string): void {
    this.store.delete(key);
    const generation = this.nextGeneration(key);
    this.track(key, generation, () => this.backing.delete(key));
  }

  list(prefix: string): string[] {
    const out: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out.sort();
  }

  /**
   * Await queued write-backs and retry each key whose latest desired value
   * previously failed. A failed key is sticky: flush rejects until a retry
   * commits the current in-memory value/delete to the backing store. This is
   * intentionally stronger than reporting an error once and then forgetting
   * it, because an unload flush must not claim durability after a quota or
   * connection failure.
   */
  async flush(): Promise<void> {
    await this.waitForPending();

    // Retry once per failed key on every flush. A persistent failure rejects
    // this flush; the next flush gets another attempt after the backing is
    // healed. Snapshot generations so a concurrent write remains authoritative
    // and cannot be cleared by an older retry.
    const retryKeys = [...this.failedKeys];
    for (const key of retryKeys) {
      if (!this.failedKeys.has(key)) continue;
      const generation = this.writeGenerations.get(key);
      if (generation === undefined) continue;
      this.track(key, generation, () => this.desiredWrite(key));
    }
    await this.waitForPending();

    if (this.failedKeys.size > 0) {
      const firstKey = this.failedKeys.values().next().value as string;
      throw this.failedErrors.get(firstKey) ?? new Error("SyncKvCache: write-back failed");
    }
  }
}
