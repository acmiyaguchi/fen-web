import { test } from "node:test";
import assert from "node:assert/strict";

import { ScriptedFetch } from "./stubFetch.js";
import { FetchPoller } from "./pollProtocol.js";
import type { HostFetch } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("fetchStart/fetchPoll drains chunks then reports done", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({
    status: 200,
    headers: { "x-test": "1" },
    chunks: ["a", "b", "c"],
    delayMs: 5,
  });

  const poller = new FetchPoller(stub);
  const id = poller.start({ method: "GET", url: "https://example.com" });

  const allChunks: string[] = [];
  let final = poller.poll(id);
  let iterations = 0;
  while (!final.done && iterations < 1000) {
    allChunks.push(...final.chunks);
    await sleep(2);
    final = poller.poll(id);
    iterations++;
  }
  allChunks.push(...final.chunks);

  assert.ok(final.done, "expected request to complete");
  assert.deepEqual(allChunks, ["a", "b", "c"]);
  assert.equal(final.status, 200);
  assert.deepEqual(final.headers, { "x-test": "1" });
  assert.equal(final.body, "abc");
  assert.equal(final.error, undefined);

  // Polling again after done is safe and returns no new chunks.
  const after = poller.poll(id);
  assert.deepEqual(after.chunks, []);
  assert.ok(after.done);
});

test("fetchPoll surfaces {error} from a failed request", async () => {
  const stub = new ScriptedFetch();
  stub.enqueue({ status: 200, chunks: [], hang: true });

  const poller = new FetchPoller(stub);
  const id = poller.start({ method: "GET", url: "https://example.com", timeoutMs: 15 });

  let final = poller.poll(id);
  let iterations = 0;
  while (!final.done && iterations < 1000) {
    await sleep(2);
    final = poller.poll(id);
    iterations++;
  }

  assert.ok(final.done);
  assert.equal(final.error, "timeout");
  assert.equal(final.status, undefined);
});

test("fetchPoll returns trailing chunks and the error on the same poll for a mid-stream failure", async () => {
  // A host whose onChunk fires twice synchronously and then the fetch
  // rejects (simulating a connection dropping mid-stream, after some
  // bytes already arrived). Both the buffered chunks and the resulting
  // error must show up together the first time poll() is called after
  // the promise settles — chunks must not be silently dropped just
  // because the request ultimately failed.
  const flaky: HostFetch = {
    async fetch(opts) {
      opts.onChunk?.("chunk-1");
      opts.onChunk?.("chunk-2");
      throw new Error("connection dropped");
    },
  };

  const poller = new FetchPoller(flaky);
  const id = poller.start({ method: "GET", url: "https://example.com" });

  // Let the microtask queue drain so the promise above settles before we
  // poll — start() does not block.
  await new Promise((resolve) => setImmediate(resolve));

  const result = poller.poll(id);
  assert.ok(result.done);
  assert.deepEqual(result.chunks, ["chunk-1", "chunk-2"]);
  assert.equal(result.error, "connection dropped");
  assert.equal(result.status, undefined);
});
