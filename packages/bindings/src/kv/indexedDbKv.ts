import type { HostKv } from "./types.js";
import {
  FS_PREFIX,
  SEED_MARKER_KEY,
  fsKeyFor,
  validateStarterFiles,
} from "./starterSeed.js";

const STORE_NAME = "kv";
const DEFAULT_RECONNECT_DELAYS_MS = [500, 2_000, 8_000] as const;

/** An IndexedDB write failed because the browser's storage quota was reached.
 * Keeping a stable error name makes this distinguishable from an ordinary
 * transaction failure, including when the original DOMException came from a
 * different browser realm. */
export class IndexedDbQuotaError extends Error {
  override readonly name = "QuotaExceededError";
  readonly cause: unknown;

  constructor(operation: string, cause?: unknown) {
    super(`IndexedDbKv: storage quota exceeded while ${operation}`);
    this.cause = cause;
  }
}

/** The backing database could not be opened after bounded reconnect retries. */
export class IndexedDbUnavailableError extends Error {
  override readonly name = "IndexedDbUnavailableError";
  readonly cause: unknown;

  constructor(dbName: string, cause?: unknown) {
    super(`IndexedDbKv: storage is unavailable for database ${JSON.stringify(dbName)}`);
    this.cause = cause;
  }
}

/** Optional hooks and test seams for an IndexedDB connection. */
export interface IndexedDbKvOptions {
  /** Observe an upgrade blocked by another open connection. Must not settle it. */
  onBlocked?: (dbName: string) => void;
  /** Delay before each reconnect retry. Defaults to 0.5s, 2s, and 8s. */
  reconnectDelaysMs?: readonly number[];
}

/** Recognize quota errors across browser realms and fake/native IDB objects. */
export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof IndexedDbQuotaError) return true;
  if (!error || typeof error !== "object") return false;
  try {
    const value = error as { name?: unknown; code?: unknown };
    return value.name === "QuotaExceededError" || value.code === 22;
  } catch {
    return false;
  }
}

type KeyRangeFactory = Pick<typeof IDBKeyRange, "lowerBound">;

/** IndexedDB-backed HostKv: a single object store, string keys, string
 * values. Raw IndexedDB API only — no wrapper dependency (idb, etc.), per
 * the no-external-runtime-deps constraint. */
export class IndexedDbKv implements HostKv {
  private dbPromise: Promise<IDBDatabase>;
  private db: IDBDatabase | undefined;
  private closed = false;
  private terminalError: IndexedDbUnavailableError | undefined;
  private readonly reconnectDelaysMs: readonly number[];
  /** Consecutive close-triggered reopens whose connection died young. */
  private closeStreak = 0;
  private openedAt = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffResolve: (() => void) | undefined;

  constructor(
    private readonly dbName = "fen-kv",
    private readonly indexedDB: IDBFactory = globalThis.indexedDB,
    private readonly keyRange: KeyRangeFactory = globalThis.IDBKeyRange,
    options: IndexedDbKvOptions = {},
  ) {
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.onBlocked = options.onBlocked;
    this.dbPromise = this.startOpen();
  }

  private readonly onBlocked: ((dbName: string) => void) | undefined;

  /** Start an open and install the schema without hiding open errors. */
  private openOnce(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.indexedDB.open(this.dbName, 1);
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      // Per IndexedDB, blocked is informational: the request remains pending
      // and will receive onsuccess once the blocking connection closes.
      request.onblocked = () => {
        try {
          if (this.onBlocked) this.onBlocked(this.dbName);
          else console.warn(`IndexedDbKv: opening database ${JSON.stringify(this.dbName)} is blocked`);
        } catch {
          // Diagnostics/reporting must never alter the IDB open lifecycle.
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          try {
            db.close();
          } catch {
            // Best effort for a late fake/native event.
          }
          return;
        }
        if (this.closed) {
          try {
            db.close();
          } catch {
            // Best effort for a close racing open success.
          }
          fail(new Error("IndexedDbKv: database is closed"));
          return;
        }
        settled = true;
        resolve(db);
      };
      request.onerror = () =>
        fail(request.error ?? new Error("IndexedDbKv: open failed"));
    });
  }

  private async openWithRetries(): Promise<IDBDatabase> {
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.openOnce();
      } catch (error) {
        lastError = error;
        if (this.closed) throw error;
        const delay = this.reconnectDelaysMs[attempt];
        if (delay === undefined) {
          throw new IndexedDbUnavailableError(this.dbName, lastError);
        }
        await this.backoffSleep(delay);
        if (this.closed) throw lastError instanceof Error ? lastError : new Error("IndexedDbKv: database is closed");
      }
    }
  }

  /** Backoff wait whose timer is owned by the instance: close() cancels it
   * (waking the sleeper, which then observes `closed`) so a discarded
   * instance never holds a dangling timer or issues a posthumous open. */
  private backoffSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.backoffResolve = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = undefined;
        this.backoffResolve = undefined;
        resolve();
      }, Math.max(0, ms));
    });
  }

  /** Begin one bounded open sequence. A no-op rejection observer prevents an
   * unhandled rejection before the next HostKv operation awaits it. */
  private startOpen(): Promise<IDBDatabase> {
    const promise = this.openWithRetries();
    this.dbPromise = promise;
    promise.then(
      (db) => {
        if (this.closed || this.dbPromise !== promise) {
          try {
            db.close();
          } catch {
            // Best effort for an open superseded by close/revival.
          }
          return;
        }
        this.db = db;
        this.openedAt = Date.now();
        db.onversionchange = () => this.connectionClosed(db, true);
        db.onclose = () => this.connectionClosed(db, false);
      },
      (error) => {
        if (this.dbPromise !== promise || this.closed) return;
        this.terminalError =
          error instanceof IndexedDbUnavailableError
            ? error
            : new IndexedDbUnavailableError(this.dbName, error);
      },
    );
    promise.catch(() => {});
    return promise;
  }

  /** Get the current connection, lazily reviving a terminally failed open. */
  private async database(): Promise<IDBDatabase> {
    if (this.closed) throw new Error("IndexedDbKv: database is closed");
    if (this.terminalError) {
      this.terminalError = undefined;
      this.startOpen();
    }
    return this.dbPromise;
  }

  /** Replace a lost connection with a fresh bounded open. Events from stale
   * connections are ignored so an old close cannot invalidate a new one. */
  private connectionClosed(db: IDBDatabase, closeFirst: boolean): void {
    if (this.db !== db) return;
    this.db = undefined;
    if (closeFirst) {
      try {
        db.close();
      } catch {
        // Closing is best effort; the connection is already detached here.
      }
    }
    if (this.closed) return;
    this.terminalError = undefined;
    // Backoff applies to close-triggered reopens too, not only to open
    // failures: a store that closes every connection moments after opening
    // must not hot-loop (a flapping fake reached 740 opens/second when the
    // streak reset on every successful open). A connection that survived
    // CLOSE_STREAK_RESET_MS is considered healthy and resets the streak.
    if (Date.now() - this.openedAt >= IndexedDbKv.CLOSE_STREAK_RESET_MS) {
      this.closeStreak = 0;
    }
    this.closeStreak += 1;
    if (this.closeStreak === 1) {
      this.startOpen();
      return;
    }
    const delay = this.reconnectDelaysMs[this.closeStreak - 2];
    if (delay === undefined) {
      this.closeStreak = 0;
      this.terminalError = new IndexedDbUnavailableError(
        this.dbName,
        new Error("connection closed repeatedly after reopening"),
      );
      return;
    }
    const pending = this.backoffSleep(delay).then(() => {
      if (this.closed) throw new Error("IndexedDbKv: database is closed");
      return this.startOpen();
    });
    pending.catch(() => {});
    this.dbPromise = pending;
  }

  /** A close-triggered reopen whose connection lives this long is healthy. */
  private static readonly CLOSE_STREAK_RESET_MS = 10_000;

  private isStaleConnection(db: IDBDatabase, error: unknown): boolean {
    if (this.db !== db) return true;
    if (!error || typeof error !== "object") return false;
    const name = (error as { name?: unknown }).name;
    return name === "InvalidStateError" || name === "TransactionInactiveError";
  }

  /** Run an operation in a transaction, retrying once when the connection
   * closes between awaiting the database and using its transaction. */
  private async runTransaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    let retried = false;
    while (true) {
      const db = await this.database();
      if (this.closed) throw new Error("IndexedDbKv: database is closed");
      try {
        const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
        return await operation(store);
      } catch (error) {
        if (!retried && !this.closed && this.isStaleConnection(db, error)) {
          // The close event normally did this already. This also handles an
          // implementation that only reports stale use synchronously.
          this.connectionClosed(db, false);
          retried = true;
          continue;
        }
        throw error;
      }
    }
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
   * a sibling request), so callers must not treat the write as durable until
   * the transaction actually commits. */
  private static wrapWrite(
    req: IDBRequest,
    tx: IDBTransaction,
    operation: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const rejectError = (error: unknown, fallback: string): void => {
        if (isQuotaExceededError(error)) {
          reject(new IndexedDbQuotaError(operation, error));
        } else {
          reject(error ?? new Error(fallback));
        }
      };
      req.onerror = () => rejectError(req.error, "IndexedDbKv: request failed");
      tx.oncomplete = () => resolve();
      tx.onerror = () => rejectError(tx.error, "IndexedDbKv: transaction failed");
      tx.onabort = () => rejectError(tx.error, "IndexedDbKv: transaction aborted");
    });
  }

  async get(key: string): Promise<string | undefined> {
    return this.runTransaction("readonly", async (store) => {
      const result = await IndexedDbKv.wrapRead(store.get(key));
      return result as string | undefined;
    });
  }

  async put(key: string, value: string): Promise<void> {
    return this.runTransaction("readwrite", async (store) => {
      const req = store.put(value, key);
      await IndexedDbKv.wrapWrite(req, store.transaction, `put(${JSON.stringify(key)})`);
    });
  }

  async delete(key: string): Promise<void> {
    return this.runTransaction("readwrite", async (store) => {
      const req = store.delete(key);
      await IndexedDbKv.wrapWrite(req, store.transaction, `delete(${JSON.stringify(key)})`);
    });
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
    return this.runTransaction("readwrite", (store) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = store.transaction;
        let seeded = false;
        const rejectTransaction = (error: unknown, fallback: string): void => {
          if (isQuotaExceededError(error)) {
            reject(new IndexedDbQuotaError("seedIfEmpty", error));
          } else {
            reject(error ?? new Error(fallback));
          }
        };
        const markerReq = store.get(markerKey);
        markerReq.onsuccess = () => {
          // A completed prior seed: leave the transaction to commit as a
          // no-op.
          if (markerReq.result !== undefined) return;
          // No marker: refuse to clobber any pre-existing user/vfs content.
          let cursorReq: IDBRequest<IDBCursor | null>;
          try {
            cursorReq = store.openKeyCursor(this.keyRange.lowerBound(FS_PREFIX));
          } catch (error) {
            rejectTransaction(error, "IndexedDbKv.seedIfEmpty: cursor failed");
            return;
          }
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
          // A request error already causes the transaction to abort in real
          // IndexedDB. Preserve the actual request error rather than calling
          // reasonless tx.abort(), which loses the useful failure cause.
          cursorReq.onerror = () =>
            rejectTransaction(cursorReq.error, "IndexedDbKv.seedIfEmpty: cursor failed");
        };
        markerReq.onerror = () =>
          rejectTransaction(markerReq.error, "IndexedDbKv.seedIfEmpty: marker read failed");
        tx.oncomplete = () => resolve(seeded);
        tx.onerror = () =>
          rejectTransaction(tx.error, "IndexedDbKv.seedIfEmpty: transaction failed");
        tx.onabort = () =>
          rejectTransaction(tx.error, "IndexedDbKv.seedIfEmpty: transaction aborted");
      }),
    );
  }

  /** Close the per-session IndexedDB connection. Safe to call more than once.
   * A connection that closes unexpectedly is reopened automatically; an
   * explicit close is final until this instance is discarded. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.backoffTimer !== undefined) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
    // Wake any backoff sleeper so it observes `closed` instead of hanging.
    this.backoffResolve?.();
    this.backoffResolve = undefined;
    const db = this.db;
    this.db = undefined;
    if (db) {
      try {
        db.close();
      } catch {
        // close() is best effort and must remain idempotent.
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Open-ended lower bound only — no synthesized upper bound (avoids
    // incrementing the last UTF-16 code unit, which is fiddly at
    // surrogate-pair/max-code-unit edges). Keys come back in ascending
    // order, so once a key no longer starts with `prefix` every subsequent
    // key won't either (they only sort greater); the loop below stops the
    // cursor there instead of scanning the whole store.
    const range = prefix === "" ? undefined : this.keyRange.lowerBound(prefix);
    return this.runTransaction("readonly", (store) => {
      const keys: string[] = [];
      return new Promise<void>((resolve, reject) => {
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
      }).then(() => keys);
    });
  }
}
