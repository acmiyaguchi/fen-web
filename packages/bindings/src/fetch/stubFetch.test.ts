import { test } from "node:test";
import assert from "node:assert/strict";

import { ScriptedFetch } from "./stubFetch.js";
import { fromLuaBytes, utf8ByteLength } from "./bytes.js";

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

test("ScriptedFetch observes a poller abort and exits a hanging stream", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: ["first", "never"], hangAfterChunks: 1 });
  let abort!: () => void;
  const pending = stub.fetch({
    method: "GET",
    url: "https://example.com",
    registerAbort: (fn) => {
      abort = fn;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  abort();
  assert.deepEqual(await pending, { error: "cancelled" });
  assert.equal(stub.abortCount, 1);
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

test("response chunks are decoded as UTF-8 text and p.body matches streamed text", async () => {
  const original = new TextEncoder().encode("café — 💥");
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [original] });

  const chunks: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (text) => {
      chunks.push(text);
    },
  });

  assert.deepEqual(chunks, ["café — 💥"]);
  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.body, chunks.join(""));
    assert.equal(result.body, "café — 💥");
  }
});

test("ScriptedFetch decodes a multi-byte character split across chunks", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({
    status: 200,
    chunks: [new Uint8Array([0xc3]), new Uint8Array([0xa9])],
  });

  const received: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (text) => {
      received.push(text);
    },
  });

  // The first wire chunk (0xc3) is only a partial multi-byte prefix, so it
  // decodes to "" and is skipped; the é surfaces once 0xa9 completes it.
  assert.deepEqual(received, ["é"]);
  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.body, "é");
    assert.equal(result.body, received.join(""));
  }
});

test("ScriptedFetch applies the body byte cap at a UTF-8 character boundary", async () => {
  const stub = new ScriptedFetch();
  const prefix = "a".repeat(65535);
  const wireText = `${prefix}é`;
  stub.enqueue({ status: 200, chunks: [wireText] });

  const received: string[] = [];
  const result = await stub.fetch({
    method: "GET",
    url: "https://example.com",
    accumulateBody: false,
    onChunk: (text) => {
      received.push(text);
    },
  });

  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.body, prefix);
    assert.equal(utf8ByteLength(result.body), 65535);
    assert.equal(received.join(""), wireText);
  }
});
