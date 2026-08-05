import { test } from "node:test";
import assert from "node:assert/strict";

import { WebHostFetch } from "./webFetch.js";
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
