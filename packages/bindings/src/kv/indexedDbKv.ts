import type { HostKv } from "./types.js";
import {
  FS_PREFIX,
  SEED_MARKER_KEY,
  fsKeyFor,
  validateStarterFiles,
} from "./starterSeed.js";

const STORE_NAME = "kv";

/** IndexedDB-backed HostKv: a single object store, string keys, string
 * values. Raw IndexedDB API only — no wrapper dependency (idb, etc.), per
 * the no-external-runtime-deps constraint. */
export class IndexedDbKv implements HostKv {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName = "fen-kv", private readonly indexedDB: IDBFactory = globalThis.indexedDB) {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = this.indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDbKv: open failed"));
    });
    // Attach a no-op observer so a rejected open (e.g. IndexedDB blocked
    // or unavailable) doesn't surface as an unhandled rejection before
    // any method actually awaits dbPromise; get/put/delete/list still see
    // the real rejection when they await it themselves.
    this.dbPromise.catch(() => {});
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  /** Wrap a read request: resolves as soon as the individual request
   * succeeds, which is correct for reads (no cross-request atomicity to
   * wait for). */
  private static wrapRead<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDbKv: request failed"));
    });
  }

  /** Wrap a write request: resolves on the transaction's oncomplete, not
   * the request's onsuccess — a request can succeed and the surrounding
   * transaction can still abort (quota, constraint, unexpected error in
   * a sibling request), so callers must not treat the write as durable
   * until the transaction actually commits. */
  private static wrapWrite(req: IDBRequest, tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error ?? new Error("IndexedDbKv: request failed"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDbKv: transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDbKv: transaction aborted"));
    });
  }

  async get(key: string): Promise<string | undefined> {
    const store = await this.store("readonly");
    const result = await IndexedDbKv.wrapRead(store.get(key));
    return result as string | undefined;
  }

  async put(key: string, value: string): Promise<void> {
    const store = await this.store("readwrite");
    const req = store.put(value, key);
    await IndexedDbKv.wrapWrite(req, store.transaction);
  }

  async delete(key: string): Promise<void> {
    const store = await this.store("readwrite");
    const req = store.delete(key);
    await IndexedDbKv.wrapWrite(req, store.transaction);
  }

  /**
   * Atomically seed the starter project (fen-web#9) into the store on a
   * genuine first load, in a SINGLE readwrite IndexedDB transaction, and
   * report whether it wrote.
   *
   * This is the review's race + durability fix. IndexedDB serializes readwrite
   * transactions on an object store, so the conditional check and the writes
   * cannot interleave with another tab: a concurrent seed runs entirely before
   * or after this one and then sees the marker / existing files and no-ops —
   * user work is never clobbered. The commit is all-or-nothing (the whole
   * transaction aborts on any error, persisting nothing) and durable (it only
   * resolves on `oncomplete`), so a page close / quota / abort leaves the
   * store untouched and the next boot retries rather than inheriting a broken
   * half-seed. The gate is cheap: one marker `get` plus a one-step key cursor,
   * never a full workspace walk+sort.
   *
   * Gate: seed only when the seed-complete marker is absent AND no "fs:" file
   * exists (a returning user with files but no marker is treated as their work
   * and left alone). The marker is written last within the same transaction.
   */
  async seedIfEmpty(
    files: Record<string, string>,
    markerKey: string = SEED_MARKER_KEY,
  ): Promise<boolean> {
    const valid = validateStarterFiles(files);
    const db = await this.dbPromise;
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let seeded = false;
      const markerReq = store.get(markerKey);
      markerReq.onsuccess = () => {
        // A completed prior seed: leave the (empty) transaction to commit as a
        // no-op.
        if (markerReq.result !== undefined) return;
        // No marker: refuse to clobber any pre-existing user/vfs content.
        const cursorReq = store.openKeyCursor(IDBKeyRange.lowerBound(FS_PREFIX));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && String(cursor.key).startsWith(FS_PREFIX)) return;
          // Empty + unmarked: commit every starter file plus the marker last,
          // all within this one atomic transaction.
          for (const [path, contents] of Object.entries(valid)) {
            store.put(contents, fsKeyFor(path));
          }
          store.put(new Date().toISOString(), markerKey);
          seeded = true;
        };
        cursorReq.onerror = () => tx.abort();
      };
      markerReq.onerror = () => tx.abort();
      tx.oncomplete = () => resolve(seeded);
      tx.onerror = () =>
        reject(tx.error ?? new Error("IndexedDbKv.seedIfEmpty: transaction failed"));
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDbKv.seedIfEmpty: transaction aborted"));
    });
  }

  async list(prefix: string): Promise<string[]> {
    const store = await this.store("readonly");
    // Open-ended lower bound only — no synthesized upper bound (avoids
    // incrementing the last UTF-16 code unit, which is fiddly at
    // surrogate-pair/max-code-unit edges). Keys come back in ascending
    // order, so once a key no longer starts with `prefix` every
    // subsequent key won't either (they only sort greater); the loop
    // below stops the cursor there instead of scanning the whole store.
    const range = prefix === "" ? undefined : IDBKeyRange.lowerBound(prefix);
    const keys: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const key = cursor.key as string;
        if (!key.startsWith(prefix)) {
          resolve();
          return;
        }
        keys.push(key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDbKv: cursor failed"));
    });
    return keys;
  }
}
