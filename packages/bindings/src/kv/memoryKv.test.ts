import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryKv } from "./memoryKv.js";

test("MemoryKv put/get round trip", async () => {
  const kv = new MemoryKv();
  await kv.put("a", "1");
  assert.equal(await kv.get("a"), "1");
  assert.equal(await kv.get("missing"), undefined);
});

test("MemoryKv delete removes a key", async () => {
  const kv = new MemoryKv();
  await kv.put("a", "1");
  await kv.delete("a");
  assert.equal(await kv.get("a"), undefined);
});

test("MemoryKv list returns sorted keys matching a prefix", async () => {
  const kv = new MemoryKv();
  await kv.put("fs/a.txt", "1");
  await kv.put("fs/b.txt", "2");
  await kv.put("other/c.txt", "3");

  assert.deepEqual(await kv.list("fs/"), ["fs/a.txt", "fs/b.txt"]);
  assert.deepEqual(await kv.list(""), ["fs/a.txt", "fs/b.txt", "other/c.txt"]);
  assert.deepEqual(await kv.list("nope/"), []);
});
