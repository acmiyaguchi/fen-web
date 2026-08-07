import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IndexedDbKv,
  IndexedDbQuotaError,
  IndexedDbUnavailableError,
} from "./indexedDbKv.js";
import { SEED_MARKER_KEY } from "./starterSeed.js";

type Handler = ((this: unknown, event: Event) => unknown) | null;

type QueuedRequest<T> = {
  request: FakeRequest<T>;
  work: () => T;
};

const ABSENT = Symbol("absent");

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;

  succeed(result: T): void {
    this.result = result;
    this.onsuccess?.call(this, {} as Event);
  }
}

class FakeCursor {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly request: FakeRequest<IDBCursor | null>,
    private readonly keys: string[],
    private readonly index: number,
  ) {}

  get key(): string {
    return this.keys[this.index];
  }

  continue(): void {
    this.tx.enqueue(this.request, () => {
      const next = this.index + 1;
      return next < this.keys.length
        ? (new FakeCursor(this.tx, this.request, this.keys, next) as unknown as IDBCursor)
        : null;
    });
  }
}

/** A small IDB model: transactions for the object store are queued and run
 * against the live map in order. It intentionally does not snapshot and
 * replace the whole map when a transaction completes, which would make
 * concurrent writes clobber each other unlike real IndexedDB. */
class FakeTransaction {
  readonly objectStoreNames = [] as unknown as DOMStringList;
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private readonly requests: Array<QueuedRequest<unknown>> = [];
  private readonly before = new Map<string, string | typeof ABSENT>();
  private started = false;
  private processing = false;
  private completionQueued = false;
  private aborted = false;
  private abortEventQueued = false;

  constructor(
    readonly db: FakeDatabase,
    readonly mode: IDBTransactionMode,
  ) {
    db.queueTransaction(this);
  }

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this);
  }

  start(): void {
    this.started = true;
    if (this.aborted) {
      this.db.finishTransaction(this);
      return;
    }
    this.drain();
  }

  enqueue<T>(request: FakeRequest<T>, work: () => T): void {
    if (this.aborted) return;
    this.requests.push({
      request,
      work,
    } as QueuedRequest<unknown>);
    this.drain();
  }

  abort(error?: unknown): void {
    if (this.aborted) return;
    this.rollback();
    this.aborted = true;
    this.error = error as DOMException | null;
    if (this.abortEventQueued) return;
    this.abortEventQueued = true;
    queueMicrotask(() => {
      // An explicit IDBTransaction.abort() fires abort, not error. Request or
      // engine failures use fail(), below, and may also report transaction
      // error before abort.
      this.onabort?.call(this, {} as Event);
      this.db.finishTransaction(this);
    });
  }

  private fail(error: unknown): void {
    if (this.aborted) return;
    this.rollback();
    this.aborted = true;
    this.error = error as DOMException;
    if (this.abortEventQueued) return;
    this.abortEventQueued = true;
    queueMicrotask(() => {
      this.onerror?.call(this, {} as Event);
      this.onabort?.call(this, {} as Event);
      this.db.finishTransaction(this);
    });
  }

  set(key: string, value: string): void {
    this.remember(key);
    this.db.data.set(key, value);
  }

  remove(key: string): void {
    this.remember(key);
    this.db.data.delete(key);
  }

  private remember(key: string): void {
    if (this.before.has(key)) return;
    this.before.set(key, this.db.data.has(key) ? (this.db.data.get(key) as string) : ABSENT);
  }

  private rollback(): void {
    for (const [key, value] of this.before) {
      if (value === ABSENT) this.db.data.delete(key);
      else this.db.data.set(key, value);
    }
  }

  private drain(): void {
    if (!this.started || this.processing || this.aborted) return;
    const next = this.requests.shift();
    if (!next) {
      this.maybeComplete();
      return;
    }
    this.processing = true;
    queueMicrotask(() => {
      try {
        if (this.db.closed) {
          throw { name: "InvalidStateError" };
        }
        next.request.error = null;
        next.request.succeed(next.work());
      } catch (error) {
        next.request.error = error as DOMException;
        next.request.onerror?.call(next.request, {} as Event);
        this.fail(error);
      } finally {
        this.processing = false;
        if (!this.aborted) this.drain();
        this.maybeComplete();
      }
    });
  }

  private maybeComplete(): void {
    if (
      !this.started ||
      this.requests.length !== 0 ||
      this.processing ||
      this.completionQueued ||
      this.aborted
    ) {
      return;
    }
    this.completionQueued = true;
    queueMicrotask(() => {
      this.completionQueued = false;
      if (
        this.requests.length !== 0 ||
        this.processing ||
        this.aborted
      ) {
        this.drain();
        return;
      }
      this.oncomplete?.call(this, {} as Event);
      this.db.finishTransaction(this);
    });
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction) {}

  get transaction(): FakeTransaction {
    return this.tx;
  }

  get(key: string): FakeRequest<string | undefined> {
    const request = new FakeRequest<string | undefined>();
    this.tx.enqueue(request, () => this.tx.db.data.get(key));
    return request;
  }

  put(value: string, key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.tx.enqueue(request, () => {
      const failure = this.tx.db.factory.consumeWriteFailure();
      if (failure) throw failure;
      this.tx.set(key, value);
      return key;
    });
    return request;
  }

  delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.tx.enqueue(request, () => {
      this.tx.remove(key);
      return undefined;
    });
    return request;
  }

  openCursor(range?: FakeRange): FakeRequest<IDBCursor | null> {
    return this.cursor(range);
  }

  openKeyCursor(range?: FakeRange): FakeRequest<IDBCursor | null> {
    return this.cursor(range);
  }

  private cursor(range?: FakeRange): FakeRequest<IDBCursor | null> {
    const request = new FakeRequest<IDBCursor | null>();
    this.tx.enqueue(request, () => {
      const keys = [...this.tx.db.data.keys()]
        .filter((key) => range === undefined || key >= range.lower)
        .sort();
      return keys.length === 0
        ? null
        : (new FakeCursor(this.tx, request, keys, 0) as unknown as IDBCursor);
    });
    return request;
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;
  readonly objectStoreNames = {
    contains: (name: string) => name === "kv" && this.hasStore,
  } as unknown as DOMStringList;
  hasStore: boolean;

  constructor(readonly factory: FakeIndexedDbFactory, readonly data: Map<string, string>) {
    this.hasStore = factory.hasStore;
  }

  createObjectStore(): FakeObjectStore {
    this.hasStore = true;
    this.factory.hasStore = true;
    return new FakeObjectStore(new FakeTransaction(this, "versionchange" as IDBTransactionMode));
  }

  transaction(_name: string, mode: IDBTransactionMode): FakeTransaction {
    if (this.closed) throw { name: "InvalidStateError" };
    if (!this.hasStore) throw new Error("object store missing");
    return new FakeTransaction(this, mode);
  }

  queueTransaction(tx: FakeTransaction): void {
    this.factory.queueTransaction(this, tx);
  }

  finishTransaction(tx: FakeTransaction): void {
    this.factory.finishTransaction(this, tx);
  }

  close(): void {
    this.closed = true;
  }

  emitClose(): void {
    this.closed = true;
    this.onclose?.call(this, {} as Event);
  }

  emitVersionChange(): void {
    this.onversionchange?.call(this, {} as Event);
  }
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeIndexedDbFactory {
  readonly data = new Map<string, string>();
  readonly connections: FakeDatabase[] = [];
  hasStore = false;
  openCount = 0;
  private readonly transactions: Array<{ db: FakeDatabase; tx: FakeTransaction }> = [];
  private activeTransaction: FakeTransaction | undefined;
  blockNextOpen = false;
  failOpenCount = 0;
  failNextWrite = false;

  queueTransaction(db: FakeDatabase, tx: FakeTransaction): void {
    this.transactions.push({ db, tx });
    this.pumpTransactions();
  }

  finishTransaction(_db: FakeDatabase, tx: FakeTransaction): void {
    if (this.activeTransaction !== tx) return;
    this.activeTransaction = undefined;
    this.pumpTransactions();
  }

  private pumpTransactions(): void {
    if (this.activeTransaction) return;
    const next = this.transactions.shift();
    if (!next) return;
    this.activeTransaction = next.tx;
    next.tx.start();
  }

  open(): FakeOpenRequest {
    this.openCount += 1;
    const request = new FakeOpenRequest();
    const deliverSuccess = (): void => {
      const db = new FakeDatabase(this, this.data);
      this.connections.push(db);
      request.result = db as unknown as IDBDatabase;
      if (!this.hasStore) request.onupgradeneeded?.call(request, {} as Event);
      request.succeed(db as unknown as IDBDatabase);
    };
    queueMicrotask(() => {
      if (this.failOpenCount > 0) {
        this.failOpenCount -= 1;
        request.error = { name: "InvalidStateError" } as unknown as DOMException;
        request.onerror?.call(request, {} as Event);
        return;
      }
      if (this.blockNextOpen) {
        this.blockNextOpen = false;
        request.onblocked?.call(request, {} as Event);
        // A blocked upgrade remains pending; the blocker closes and the same
        // request later receives success.
        queueMicrotask(deliverSuccess);
        return;
      }
      deliverSuccess();
    });
    return request;
  }

  consumeWriteFailure(): DOMException | undefined {
    if (!this.failNextWrite) return undefined;
    this.failNextWrite = false;
    return { name: "QuotaExceededError", code: 22 } as unknown as DOMException;
  }
}

const keyRange = {
  lowerBound: (value: string) => new FakeRange(value),
} as unknown as Pick<typeof IDBKeyRange, "lowerBound">;

class FakeRange {
  constructor(readonly lower: string) {}
}

const STARTER = {
  "/index.html": "<title>Starter</title>",
  "/app.js": "window.app = true;",
};

function openKv(
  factory = new FakeIndexedDbFactory(),
  options: ConstructorParameters<typeof IndexedDbKv>[3] = { reconnectDelaysMs: [] },
): {
  kv: IndexedDbKv;
  factory: FakeIndexedDbFactory;
} {
  return {
    factory,
    kv: new IndexedDbKv("test-kv", factory as unknown as IDBFactory, keyRange, options),
  };
}

test("IndexedDbKv.list stops the cursor at the first key outside a prefix", async () => {
  const { kv, factory } = openKv();
  await kv.put("app/a", "a");
  await kv.put("app/b", "b");
  await kv.put("other/c", "c");

  assert.deepEqual(await kv.list("app/"), ["app/a", "app/b"]);
  assert.deepEqual(await kv.list(""), ["app/a", "app/b", "other/c"]);
  await kv.close();
  assert.equal(factory.connections.at(-1)?.closed, true);
});

test("IndexedDbKv.seedIfEmpty commits all files atomically and never clobbers", async () => {
  const failing = new FakeIndexedDbFactory();
  failing.failNextWrite = true;
  const failed = openKv(failing).kv;
  await assert.rejects(
    () => failed.seedIfEmpty(STARTER),
    (error: unknown) => error instanceof IndexedDbQuotaError && error.name === "QuotaExceededError",
  );
  assert.deepEqual([...failing.data], [], "an aborted seed must leave no partial files");
  await failed.close();

  const { kv } = openKv();
  assert.equal(await kv.seedIfEmpty(STARTER), true);
  assert.equal(await kv.seedIfEmpty(STARTER), false);
  assert.equal(await kv.get(SEED_MARKER_KEY) !== undefined, true);
  await kv.close();

  const withUserWork = new FakeIndexedDbFactory();
  const userKv = openKv(withUserWork).kv;
  await userKv.put("fs:/mine.txt", "user work");
  assert.equal(await userKv.seedIfEmpty(STARTER), false);
  assert.equal(await userKv.get("fs:/mine.txt"), "user work");
  assert.equal(await userKv.get(SEED_MARKER_KEY), undefined);
  await userKv.close();
});

test("IndexedDbKv serializes concurrent seed transactions across connections", async () => {
  const factory = new FakeIndexedDbFactory();
  const first = openKv(factory).kv;
  const second = openKv(factory).kv;
  const results = await Promise.all([first.seedIfEmpty(STARTER), second.seedIfEmpty(STARTER)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(factory.data.get(SEED_MARKER_KEY) !== undefined, true);
  assert.equal(factory.data.get("fs:/index.html"), STARTER["/index.html"]);
  await first.close();
  await second.close();
});

test("IndexedDbKv distinguishes a quota-exceeded write from a generic failure", async () => {
  const { kv, factory } = openKv();
  factory.failNextWrite = true;
  await assert.rejects(
    () => kv.put("large", "value"),
    (error: unknown) => error instanceof IndexedDbQuotaError && error.name === "QuotaExceededError",
  );
  await kv.close();
});

test("IndexedDbKv retries a transient reconnect failure", async () => {
  const factory = new FakeIndexedDbFactory();
  const { kv } = openKv(factory, { reconnectDelaysMs: [0] });
  await kv.put("before", "1");
  const first = factory.connections.at(-1);
  assert.ok(first);

  factory.failOpenCount = 1;
  first.emitClose();
  await kv.put("after-transient", "2");
  assert.equal(await kv.get("after-transient"), "2");
  assert.equal(factory.openCount, 3, "initial open + failed reconnect + retry");
  await kv.close();
});

test("IndexedDbKv surfaces exhausted reconnects distinctly and lazily revives", async () => {
  const factory = new FakeIndexedDbFactory();
  const { kv } = openKv(factory, { reconnectDelaysMs: [0, 0, 0] });
  await kv.put("before", "1");
  const first = factory.connections.at(-1);
  assert.ok(first);

  factory.failOpenCount = 10;
  first.emitClose();
  await assert.rejects(
    () => kv.put("unavailable", "value"),
    (error: unknown) => error instanceof IndexedDbUnavailableError && error.name === "IndexedDbUnavailableError",
  );
  assert.equal(factory.openCount, 5, "initial open + three retries plus the failed operation's first open");

  factory.failOpenCount = 0;
  await kv.put("revived", "value");
  assert.equal(await kv.get("revived"), "value");
  assert.equal(factory.openCount, 6, "a later operation gets one fresh lazy open");
  await kv.close();
});

test("IndexedDbKv bounds close-triggered reopens (no flapping-store livelock)", async () => {
  const factory = new FakeIndexedDbFactory();
  const { kv } = openKv(factory, { reconnectDelaysMs: [0, 0] });
  await kv.put("before", "1");

  // A store that closes every fresh connection immediately must exhaust the
  // backoff schedule and go terminal, not hot-loop reopening forever (the
  // pre-fix behavior reset the bound on every successful open: 740 opens/s
  // against a flapping fake).
  const closeLatest = () => factory.connections.at(-1)?.emitClose();
  closeLatest();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    closeLatest();
  }
  const opens = factory.openCount;
  assert.ok(
    opens <= 5,
    `close-triggered reopens must be bounded by the backoff schedule (saw ${opens})`,
  );
  await kv.close();
});

test("IndexedDbKv keeps a blocked open pending until it succeeds", async () => {
  const factory = new FakeIndexedDbFactory();
  factory.blockNextOpen = true;
  const blocked: string[] = [];
  const { kv } = openKv(factory, { reconnectDelaysMs: [], onBlocked: (name) => blocked.push(name) });
  assert.equal(await kv.get("blocked"), undefined);
  assert.deepEqual(blocked, ["test-kv"]);
  assert.equal(factory.openCount, 1);
  await kv.close();
});

test("IndexedDbKv retries an in-flight write after its connection closes", async () => {
  const factory = new FakeIndexedDbFactory();
  const { kv } = openKv(factory);
  await kv.put("before", "1");
  const first = factory.connections.at(-1);
  assert.ok(first);

  const write = kv.put("during-close", "2");
  await Promise.resolve();
  first.emitClose();
  await write;
  assert.equal(await kv.get("during-close"), "2");
  assert.ok(factory.openCount >= 2);
  await kv.close();
});

test("IndexedDbKv preserves all concurrent fire-and-forget puts", async () => {
  const { kv, factory } = openKv();
  const count = 12;
  const writes = Array.from({ length: count }, (_, index) => {
    const key = `concurrent/${index}`;
    return kv.put(key, String(index));
  });
  await Promise.all(writes);
  assert.deepEqual(
    await kv.list("concurrent/"),
    Array.from({ length: count }, (_, index) => `concurrent/${index}`).sort(),
  );
  assert.equal(factory.data.size, count);
  await kv.close();
});

test("FakeTransaction models explicit abort without an error event", async () => {
  const { kv, factory } = openKv();
  await kv.put("existing", "value");
  const db = factory.connections.at(-1);
  assert.ok(db);
  const tx = db.transaction("kv", "readwrite");
  let errors = 0;
  let aborts = 0;
  tx.onerror = () => {
    errors += 1;
  };
  tx.onabort = () => {
    aborts += 1;
  };
  tx.abort();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(errors, 0);
  assert.equal(aborts, 1);
  await kv.close();
});

test("IndexedDbKv reconnects after version-change events", async () => {
  const { kv, factory } = openKv();
  await kv.put("before", "1");
  const first = factory.connections.at(-1);
  assert.ok(first);

  first.emitVersionChange();
  await kv.put("after-version-change", "3");
  assert.ok(factory.openCount >= 2);
  assert.equal(await kv.get("after-version-change"), "3");
  await kv.close();
});
