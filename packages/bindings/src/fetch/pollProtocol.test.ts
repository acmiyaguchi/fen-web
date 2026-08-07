import { test } from "node:test";
import assert from "node:assert/strict";

import { ScriptedFetch } from "./stubFetch.js";
import { WebHostFetch } from "./webFetch.js";
import {
  FetchPoller,
  FetchPollerBackpressureError,
  FetchPollerDisposedError,
  MAX_PENDING_BYTES,
  MAX_PENDING_CHUNKS,
} from "./pollProtocol.js";
import type { HostFetch } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(): Promise<void> {
  // A few turns cover start().fetch().then().catch() plus an awaited
  // onChunk backpressure continuation without relying on wall-clock sleeps.
  for (let i = 0; i < 8; i++) await Promise.resolve();
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

test("fetchPoll applies bounded backpressure without dropping streamed chunks", async () => {
  const chunkCount = 300;
  const produced = Array.from({ length: chunkCount }, (_, index) => `${index},`);
  let backpressured = false;
  const host: HostFetch = {
    async fetch(opts) {
      for (const chunk of produced) {
        const delivery = opts.onChunk?.(chunk);
        if (delivery) {
          backpressured = true;
          await delivery;
        }
      }
      return { status: 200, headers: {}, body: "" };
    },
  };

  const poller = new FetchPoller(host);
  const id = poller.start({
    method: "GET",
    url: "https://example.com",
    accumulateBody: false,
  });
  const received: string[] = [];
  let poll = poller.poll(id);
  const firstPollChunkCount = poll.chunks.length;
  while (!poll.done) {
    received.push(...poll.chunks);
    await new Promise((resolve) => setImmediate(resolve));
    poll = poller.poll(id);
  }
  received.push(...poll.chunks);

  assert.ok(backpressured, "expected the host to wait for a poll");
  assert.ok(firstPollChunkCount < chunkCount, "the first poll must not hold the whole body");
  assert.deepEqual(received, produced);
  assert.equal(poll.body, "");
});

test("a host that ignores onChunk backpressure fails loudly instead of buffering unboundedly", async () => {
  const produced = Array.from({ length: 300 }, (_, index) => `${index},`);
  let thrown: unknown;
  const host: HostFetch = {
    async fetch(opts) {
      for (const chunk of produced) {
        try {
          // Deliberately do not await the returned backpressure promise.
          opts.onChunk?.(chunk);
        } catch (err) {
          thrown = err;
          throw err;
        }
      }
      return { status: 200, headers: {}, body: "" };
    },
  };

  const poller = new FetchPoller(host);
  const id = poller.start({ method: "GET", url: "https://example.com" });
  await flushMicrotasks();

  const received: string[] = [];
  let poll = poller.poll(id);
  while (!poll.done) {
    received.push(...poll.chunks);
    poll = poller.poll(id);
  }
  received.push(...poll.chunks);

  assert.ok(thrown instanceof FetchPollerBackpressureError);
  assert.match(poll.error ?? "", /must await onChunk backpressure/);
  assert.equal(received.length, MAX_PENDING_CHUNKS + 1);
  assert.deepEqual(received, produced.slice(0, MAX_PENDING_CHUNKS + 1));
});

test("terminal state stays non-terminal until a parked chunk is delivered", async () => {
  const host: HostFetch = {
    async fetch(opts) {
      for (let index = 0; index < MAX_PENDING_CHUNKS; index++) {
        opts.onChunk?.(`chunk-${index}`);
      }
      // Simulate a host that returns its terminal result without awaiting the
      // final backpressure promise. The poller must still expose that chunk.
      opts.onChunk?.("parked-terminal-chunk");
      return { status: 200, headers: {}, body: "" };
    },
  };

  const poller = new FetchPoller(host);
  const id = poller.start({ method: "GET", url: "https://example.com" });
  await flushMicrotasks();

  const first = poller.poll(id);
  assert.equal(first.chunks.length, MAX_PENDING_CHUNKS);
  assert.equal(first.done, false);
  const second = poller.poll(id);
  assert.deepEqual(second.chunks, ["parked-terminal-chunk"]);
  assert.equal(second.done, true);
});

test("one chunk larger than MAX_PENDING_BYTES is preserved intact", async () => {
  const oversized = "x".repeat(MAX_PENDING_BYTES + 1);
  const host: HostFetch = {
    async fetch(opts) {
      await opts.onChunk?.(oversized);
      return { status: 200, headers: {}, body: oversized };
    },
  };

  const poller = new FetchPoller(host);
  const id = poller.start({ method: "GET", url: "https://example.com" });
  await flushMicrotasks();

  const result = poller.poll(id);
  assert.deepEqual(result.chunks, [oversized]);
  assert.equal(result.done, true);
  assert.equal(result.body, oversized);
});

test("MAX_PENDING_CHUNKS is a hard queue boundary", async () => {
  const produced = Array.from({ length: MAX_PENDING_CHUNKS }, (_, index) => `${index}`);
  const host: HostFetch = {
    async fetch(opts) {
      for (const chunk of produced) opts.onChunk?.(chunk);
      return { status: 200, headers: {}, body: produced.join("") };
    },
  };

  const poller = new FetchPoller(host);
  const id = poller.start({ method: "GET", url: "https://example.com" });
  await flushMicrotasks();

  const result = poller.poll(id);
  assert.equal(result.chunks.length, MAX_PENDING_CHUNKS);
  assert.deepEqual(result.chunks, produced);
  assert.equal(result.done, true);
});

test("dispose while WebHostFetch is parked cancels the reader and releases it", async () => {
  const originalFetch = globalThis.fetch;
  let pullCount = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount++;
      controller.enqueue(new Uint8Array([pullCount & 0xff]));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;

  try {
    const poller = new FetchPoller(new WebHostFetch());
    const id = poller.start({ method: "GET", url: "https://example.com" });
    for (let attempt = 0; attempt < 32 && pullCount < MAX_PENDING_CHUNKS + 1; attempt++) {
      await flushMicrotasks();
    }
    assert.ok(
      pullCount >= MAX_PENDING_CHUNKS + 1,
      `expected the producer to park after the queue cap, got ${pullCount} pulls`,
    );

    poller.dispose(id);
    for (let attempt = 0; attempt < 32 && !cancelled; attempt++) {
      await flushMicrotasks();
    }
    assert.equal(cancelled, true, "dispose must unblock WebHostFetch so its finally cancels the reader");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("idle never counts park time: disposeAll while parked yields the disposed error, not idle timeout", async () => {
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    chunks: Array.from({ length: MAX_PENDING_CHUNKS + 1 }, () => "x"),
  });
  let observed: Awaited<ReturnType<HostFetch["fetch"]>> | undefined;
  let backpressured = false;
  const host: HostFetch = {
    async fetch(opts) {
      const result = await scripted.fetch({
        ...opts,
        onChunk: (bytes) => {
          const delivery = opts.onChunk?.(bytes);
          if (delivery) backpressured = true;
          return delivery;
        },
      });
      observed = result;
      return result;
    },
  };
  const poller = new FetchPoller(host);
  poller.start({
    method: "GET",
    url: "https://example.com",
    idleTimeoutMs: 1,
  });

  // The park lasts far longer than idleTimeoutMs, but park time must never
  // arm the idle watchdog (a hidden tab pauses polling for arbitrarily long;
  // that buffers, it doesn't kill the turn). Teardown, rather than a later
  // poll or a spurious idle abort, unblocks the producer with the
  // distinguishable disposed error.
  for (let attempt = 0; attempt < 64 && !backpressured; attempt++) await flushMicrotasks();
  assert.equal(backpressured, true, "expected ScriptedFetch to park on poller backpressure");
  await sleep(5);
  poller.disposeAll();
  for (let attempt = 0; attempt < 64 && !observed; attempt++) await flushMicrotasks();

  assert.deepEqual(observed, { error: "FetchPoller: request was disposed" });
});

test("dispose rejects a parked producer with a distinguishable cancellation error", async () => {
  let parked: PromiseLike<void> | undefined;
  let cancellation: unknown;
  const host: HostFetch = {
    async fetch(opts) {
      for (let index = 0; index < MAX_PENDING_CHUNKS; index++) opts.onChunk?.("x");
      const delivery = opts.onChunk?.("parked");
      if (delivery) parked = delivery;
      try {
        await delivery;
      } catch (err) {
        cancellation = err;
        throw err;
      }
      return { status: 200, headers: {}, body: "" };
    },
  };
  const poller = new FetchPoller(host);
  const id = poller.start({ method: "GET", url: "https://example.com" });
  await flushMicrotasks();
  assert.ok(parked, "expected a producer backpressure promise");

  poller.dispose(id);
  await flushMicrotasks();
  // The host's rejected await is converted into a terminal result, but the
  // state is intentionally gone: disposal is an abandonment operation.
  assert.throws(() => poller.poll(id), /unknown request id/);
  assert.ok(parked instanceof Promise);
  assert.ok(cancellation instanceof FetchPollerDisposedError);
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
