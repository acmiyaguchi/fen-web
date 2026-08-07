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
    onChunk: (bytes) => {
      received.push(bytes);
    },
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

test("ScriptedFetch applies an idle timeout before a delayed chunk", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: ["late"], delayMs: 20 });

  const received: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    idleTimeoutMs: 5,
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.deepEqual(result, { error: "idle timeout" });
  assert.deepEqual(received, []);
});

test("ScriptedFetch can abort after delivering a chunk", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({
    status: 200,
    chunks: ["before abort", "never delivered"],
    abortAfterChunks: 1,
    abortMessage: "stream aborted",
  });

  const received: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.deepEqual(result, { error: "stream aborted" });
  assert.deepEqual(received, ["before abort"]);
});

test("request body strings are unconditionally UTF-8 encoded", () => {
  assert.deepEqual(fromLuaBytes("café"), new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]));
  assert.deepEqual(fromLuaBytes("—"), new Uint8Array([0xe2, 0x80, 0x94]));
  assert.deepEqual(
    fromLuaBytes("café —"),
    new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xe2, 0x80, 0x94]),
  );
});

test("ScriptedFetch converts a wasmoon-shaped request body to raw wire bytes", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 204, chunks: [] });

  const result = await stub.fetch({
    method: "POST",
    url: "https://example.com",
    body: "—",
  });

  assert.ok(!("error" in result));
  assert.ok(stub.lastRequest);
  assert.deepEqual(stub.lastRequest?.body, new Uint8Array([0xe2, 0x80, 0x94]));
});

test("ScriptedFetch does not record a request when its queue is empty", async () => {
  const stub = new ScriptedFetch();

  await assert.rejects(
    () => stub.fetch({ method: "POST", url: "https://example.com", body: "café" }),
    /no scripted response queued/,
  );
  assert.equal(stub.lastRequest, undefined);
});

test("ScriptedFetch rejects non-ASCII request header values like WebHostFetch", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [] });

  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    headers: { "x-user-label": "café" },
  });

  assert.deepEqual(result, {
    error: 'HTTP header value for "x-user-label" must contain ASCII characters only',
  });
  assert.equal(stub.lastRequest, undefined);
});

test("response chunks retain their intermediate byte-string representation", async () => {
  const original = new Uint8Array([0, 1, 2, 255, 254, 128, 10, 13, 0]);
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [original] });

  const chunks: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (bytes) => {
      chunks.push(bytes);
    },
  });

  assert.equal(chunks.length, 1);
  assert.ok("body" in result);
  if ("body" in result) {
    assert.equal(result.body, chunks[0]);
  }

  // The response-side intermediate representation is deterministic. Its
  // later Lua marshalling is a separate, known response-direction issue.
  assert.equal(toLuaBytes(original), chunks[0]);
});
