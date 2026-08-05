import { test } from "node:test";
import assert from "node:assert/strict";
import { createFenRuntime } from "./index.js";

/**
 * The load-bearing spike (fen-web#1 acceptance criterion / fen-web#99
 * design findings): prove wasmoon can resume a Lua coroutine per async
 * chunk without "attempt to yield across a C-call boundary". This is the
 * exact shape interactive turn-driving (and fen's http.request /
 * core.agent.make-yield contract, see
 * fen/packages/util/tests/http_native_coop_test.fnl) will use: a Lua
 * coroutine loops { poll __fen_host; if nothing yet, coroutine.yield() },
 * and JS resumes it from real async events (setTimeout ticks here,
 * fetch stream chunks in the real binding) via `rt.createCoroutinePump`,
 * the promoted, reusable form of this pattern (see index.ts).
 *
 * Pattern documented here for reuse: the yield always happens from pure
 * Lua code (never from inside a JS-bound callback), so it never crosses
 * a C-call boundary -- that's precisely what the poll-instead-of-push
 * design in fen-web#16 buys us. The negative test below proves the
 * boundary is real (not just untested): a push-shaped callback that
 * tries to yield from inside a non-yieldable C call does error.
 */
test("coroutine bridge: JS resumes a Lua coroutine across 3+ async chunks with no C-boundary yield error", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    const queue: string[] = [];
    rt.lua.global.set("__fen_test_poll", () => {
      return queue.length > 0 ? queue.shift() : undefined;
    });

    const co = await rt.createCoroutinePump(`
      function()
        local result = {}
        while true do
          local chunk = __fen_test_poll()
          if chunk == nil then
            coroutine.yield()
          else
            table.insert(result, chunk)
            if chunk == "__DONE__" then
              return result
            end
          end
        end
      end
    `);

    async function tick(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let resumeCount = 0;
    async function pump(): Promise<string> {
      resumeCount += 1;
      return co.pump();
    }

    // Drain the initial (empty-queue) yield.
    let status = await pump();
    assert.equal(status, "suspended");

    const chunks = ["chunk-1", "chunk-2", "chunk-3"];
    for (const chunk of chunks) {
      await tick();
      queue.push(chunk);
      status = await pump();
      assert.equal(status, "suspended", `expected suspended after delivering ${chunk}`);
    }

    await tick();
    queue.push("__DONE__");
    status = await pump();
    assert.equal(status, "dead");

    assert.ok(resumeCount > 1, `expected >1 resume, got ${resumeCount}`);
    assert.equal(resumeCount, 1 + chunks.length + 1);

    const result = await co.result();
    assert.deepEqual(result, [...chunks, "__DONE__"]);
  } finally {
    rt.close();
  }
});

/**
 * Negative control for the spike above: proves the C-call-boundary
 * hazard the poll design exists to avoid is a real Lua VM constraint,
 * not something this runtime happens not to trigger. `table.sort`
 * invokes its comparator via a plain (non-yieldable) C call in standard
 * Lua 5.4, so yielding from inside the comparator must fail with
 * "attempt to yield across a C-call boundary". If a future binding tries
 * a push model (a callback that calls `coroutine.yield()` synchronously
 * from inside a non-yieldable C call instead of polling from plain Lua
 * code), this is the failure mode it would hit -- this test exists so
 * that regression is caught here, not discovered live against a
 * streaming fetch.
 */
test("coroutine bridge (negative): yielding from inside a non-yieldable C call fails at the boundary", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    const co = await rt.createCoroutinePump(`
      function()
        local t = {3, 1, 2}
        table.sort(t, function(a, b)
          coroutine.yield()
          return a < b
        end)
        return t
      end
    `);

    await assert.rejects(
      () => co.pump(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /yield/i);
        assert.match(err.message, /boundary/i);
        return true;
      },
    );
  } finally {
    rt.close();
  }
});
