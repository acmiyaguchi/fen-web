import { test } from "node:test";
import assert from "node:assert/strict";

import { WebHostFetch } from "./webFetch.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import { fromLuaBytes, toLuaBytes } from "./bytes.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a fake global fetch that resolves immediately (simulating a fast
 * connect) and then streams the given chunks with a delay between each,
 * so tests can exercise connect-timeout vs. overall/idle timeout
 * behavior without a real network. */
function fakeSlowStreamFetch(chunks: Uint8Array[], delayMs: number) {
  return async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          await sleep(delayMs);
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
}

test("connectTimeoutMs does not abort a healthy stream that runs past it", async (t) => {
  const original = globalThis.fetch;
  // Connect "succeeds" instantly (Response resolves right away); each of
  // three chunks then arrives after 40ms, so the stream takes ~120ms —
  // well past a 50ms connectTimeoutMs. Only the connect phase should be
  // bound by connectTimeoutMs; once headers arrive that timer must stop
  // applying.
  globalThis.fetch = fakeSlowStreamFetch(
    [new TextEncoder().encode("a"), new TextEncoder().encode("b"), new TextEncoder().encode("c")],
    40,
  ) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = new WebHostFetch();
  const result = await client.fetch({
    method: "GET",
    url: "https://example.com",
    connectTimeoutMs: 50,
    timeoutMs: 5000,
  });

  assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
  if (!("error" in result)) {
    assert.equal(result.status, 200);
    assert.equal(result.body, "abc");
  }
});

test("timeoutMs aborts a stream that does not finish before the deadline", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeSlowStreamFetch(
    [new TextEncoder().encode("late")],
    40,
  ) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
    timeoutMs: 10,
  });

  assert.deepEqual(result, { error: "timeout" });
});

test("idleTimeoutMs aborts after a streamed chunk goes idle", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        await sleep(40);
        if (signal?.aborted) {
          controller.error(new DOMException("aborted", "AbortError"));
        } else {
          controller.enqueue(new TextEncoder().encode("late"));
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const received: string[] = [];
  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
    timeoutMs: 500,
    idleTimeoutMs: 15,
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.deepEqual(result, { error: "idle timeout" });
  assert.deepEqual(received, ["first"]);
});

test("a timeout aborts a response after it has delivered a chunk", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        await sleep(50);
        if (signal?.aborted) {
          controller.error(new DOMException("aborted", "AbortError"));
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const received: string[] = [];
  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
    timeoutMs: 15,
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.deepEqual(result, { error: "timeout" });
  assert.deepEqual(received, ["first"]);
});

test("mid-stream aborts are mapped as fetch failures", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("before abort"));
        await sleep(5);
        controller.error(new DOMException("stream aborted", "AbortError"));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const received: string[] = [];
  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.deepEqual(result, { error: "stream aborted" });
  assert.deepEqual(received, ["before abort"]);
});

test("accumulateBody:false keeps only the capped head while streaming all chunks", async (t) => {
  const original = globalThis.fetch;
  const first = new Uint8Array(ACCUMULATE_BODY_CAP).fill(0x61);
  const second = new Uint8Array(17).fill(0x62);
  globalThis.fetch = fakeSlowStreamFetch([first, second], 0) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const received: string[] = [];
  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
    accumulateBody: false,
    onChunk: (bytes) => {
      received.push(bytes);
    },
  });

  assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
  if (!("error" in result)) {
    assert.equal(result.body?.length, ACCUMULATE_BODY_CAP);
    assert.equal(result.body?.charAt(0), "a");
    assert.equal(result.body?.charAt(result.body.length - 1), "a");
  }
  assert.equal(
    received.reduce((total, chunk) => total + chunk.length, 0),
    ACCUMULATE_BODY_CAP + second.length,
  );
  assert.equal(received[0].charAt(0), "a");
  assert.equal(received[1].charAt(0), "b");
});

test("non-2xx responses remain successful results with status and body", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("rate limited"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 429,
      headers: { "retry-after": "10" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
  });

  assert.deepEqual(result, {
    status: 429,
    headers: { "retry-after": "10" },
    body: "rate limited",
  });
});

test("network failures are mapped to a FetchFailure", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("network unreachable");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const result = await new WebHostFetch().fetch({
    method: "GET",
    url: "https://example.com",
  });

  assert.deepEqual(result, { error: "network unreachable" });
});

test("body is decoded from Lua bytes before being sent (no double UTF-8 encoding)", async () => {
  const original = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body;
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  }) as typeof fetch;
  try {
    const nonAscii = "héllo wörld — 你好 💥";
    const luaBytes = toLuaBytes(new TextEncoder().encode(nonAscii));

    const client = new WebHostFetch();
    const result = await client.fetch({
      method: "POST",
      url: "https://example.com",
      body: luaBytes,
    });

    assert.ok(!("error" in result));
    assert.ok(capturedBody instanceof Uint8Array, "expected body to be decoded to raw bytes");
    assert.deepEqual(capturedBody, fromLuaBytes(luaBytes));
    // And decoding those bytes back as UTF-8 recovers the original text —
    // proving there was no double-encoding round trip through fetch().
    assert.equal(new TextDecoder().decode(capturedBody as Uint8Array), nonAscii);
  } finally {
    globalThis.fetch = original;
  }
});
