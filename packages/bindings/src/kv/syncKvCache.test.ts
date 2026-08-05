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

test("SyncKvCache.flush surfaces a write-back error once", async () => {
  const boom = new Error("quota exceeded");
  const backing = {
    get: async () => undefined,
    list: async () => [],
    put: async () => {
      throw boom;
    },
    delete: async () => {},
  };
  const kv = await SyncKvCache.load(backing);
  kv.put("k", "v");
  await assert.rejects(() => kv.flush(), /quota exceeded/);
  // Cleared after surfacing: a subsequent clean flush resolves.
  await kv.flush();
});
