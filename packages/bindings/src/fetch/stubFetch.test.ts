import { test } from "node:test";
import assert from "node:assert/strict";

import { ScriptedFetch } from "./stubFetch.js";
import { fromLuaBytes, toLuaBytes } from "./bytes.js";

test("ScriptedFetch delivers chunks in order via onChunk", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({
    status: 200,
    headers: { "content-type": "text/plain" },
    chunks: ["hello ", "world"],
  });

  const received: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (bytes) => received.push(bytes),
  });

  assert.deepEqual(received, ["hello ", "world"]);
  assert.deepEqual(result, {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "hello world",
  });
});

test("ScriptedFetch hang produces {error} after timeoutMs", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [], hang: true });

  const start = Date.now();
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    timeoutMs: 20,
  });
  const elapsed = Date.now() - start;

  assert.deepEqual(result, { error: "timeout" });
  assert.ok(elapsed >= 15, `expected to wait roughly timeoutMs, waited ${elapsed}ms`);
});

test("binary bytes survive round-trip through toLuaBytes/fromLuaBytes", async () => {
  const original = new Uint8Array([0, 1, 2, 255, 254, 128, 10, 13, 0]);
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [original] });

  const chunks: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (bytes) => chunks.push(bytes),
  });

  assert.equal(chunks.length, 1);
  assert.deepEqual(fromLuaBytes(chunks[0]), original);
  assert.ok("body" in result);
  if ("body" in result) {
    assert.deepEqual(fromLuaBytes(result.body!), original);
  }

  // Sanity: toLuaBytes is deterministic and matches what the stub produced.
  assert.equal(toLuaBytes(original), chunks[0]);
});
