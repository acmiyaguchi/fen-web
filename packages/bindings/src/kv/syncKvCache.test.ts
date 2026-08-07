import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKv } from "./memoryKv.js";
import { SyncKvCache } from "./syncKvCache.js";

test("SyncKvCache.load snapshots the backing store into synchronous reads", async () => {
  const backing = new MemoryKv();
  await backing.put("a", "1");
  await backing.put("b", "2");

  const kv = await SyncKvCache.load(backing);
  assert.equal(kv.sync, true);
  assert.equal(kv.get("a"), "1");
  assert.equal(kv.get("b"), "2");
  assert.equal(kv.get("missing"), undefined);
});

test("SyncKvCache serves the VM's own writes synchronously, then persists on flush", async () => {
  const backing = new MemoryKv();
  const kv = await SyncKvCache.load(backing);

  kv.put("k", "v");
  // Synchronous read-your-writes: the value is visible immediately, before
  // the async write-back is awaited.
  assert.equal(kv.get("k"), "v");

  await kv.flush();
  assert.equal(await backing.get("k"), "v");
});

test("SyncKvCache.delete removes from the view and the backing store", async () => {
  const backing = new MemoryKv();
  await backing.put("k", "v");
  const kv = await SyncKvCache.load(backing);

  kv.delete("k");
  assert.equal(kv.get("k"), undefined);
  await kv.flush();
  assert.equal(await backing.get("k"), undefined);
});

test("SyncKvCache.list returns prefixed keys in ascending order", async () => {
  const backing = new MemoryKv();
  const kv = await SyncKvCache.load(backing);
  kv.put("session:2", "b");
  kv.put("session:1", "a");
  kv.put("env/apikey/ANTHROPIC_API_KEY", "sk");

  assert.deepEqual(kv.list("session:"), ["session:1", "session:2"]);
  assert.deepEqual(kv.list("env/"), ["env/apikey/ANTHROPIC_API_KEY"]);
  assert.equal(kv.list("").length, 3);
});

test("SyncKvCache keeps failed keys sticky until a later flush makes them durable", async () => {
  const boom = new Error("quota exceeded");
  let failing = true;
  const data = new Map<string, string>();
  const backing = {
    get: async (key: string) => data.get(key),
    list: async () => [...data.keys()],
    put: async (key: string, value: string) => {
      if (failing) throw boom;
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  };
  const kv = await SyncKvCache.load(backing);
  kv.put("k", "v");
  await assert.rejects(() => kv.flush(), (error: unknown) => error === boom);
  assert.equal(data.get("k"), undefined, "a failed flush must not claim durability");

  failing = false;
  await kv.flush();
  assert.equal(data.get("k"), "v", "the retry must write the current in-memory value");
});

test("SyncKvCache reports write-back failures immediately without masking them", async () => {
  const boom = new Error("write failed");
  const observed: unknown[] = [];
  const backing = {
    get: async () => undefined,
    list: async () => [],
    put: async () => {
      throw boom;
    },
    delete: async () => {},
  };
  const kv = await SyncKvCache.load(backing, (error) => {
    observed.push(error);
    throw new Error("notice failed");
  });

  kv.put("k", "v");
  await assert.rejects(() => kv.flush(), (error) => error === boom);
  assert.deepEqual(observed, [boom, boom], "the failed-key retry is observed without masking the error");
});
