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
 * synchronously (so the VM sees its own writes immediately) and are
 * queued to the backing async kv; {@link SyncKvCache.flush} awaits the
 * queue so callers/tests can confirm durability. Write-back errors are
 * captured and surfaced on the next `flush` rather than lost.
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
  private lastError: unknown = undefined;

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
    const cache = new SyncKvCache(store, backing, onError ?? (() => {}));
    return cache;
  }

  private track(op: Promise<void>): void {
    const wrapped = op
      .catch((err) => {
        this.lastError = err;
        this.onError(err);
      })
      .finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  put(key: string, value: string): void {
    this.store.set(key, value);
    this.track(this.backing.put(key, value));
  }

  delete(key: string): void {
    this.store.delete(key);
    this.track(this.backing.delete(key));
  }

  list(prefix: string): string[] {
    const out: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out.sort();
  }

  /** Await all queued write-backs; rejects with the first write-back error
   * observed since the previous flush. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    if (this.lastError !== undefined) {
      const err = this.lastError;
      this.lastError = undefined;
      throw err;
    }
  }
}
