/**
 * Built-in minimal stubs for natives that don't exist in a browser Lua VM,
 * required so `(require :fen.core.agent)`'s 33-module subgraph loads.
 * Installed into `package.preload` (preload always wins over the custom
 * searcher, so real submodule sources for these two names are never
 * consulted). Callers can override either by passing their own entry
 * under the same key in `opts.preload`.
 */

/**
 * cjson: pure-Lua JSON, not a JS bridge. See vendor/cjson_stub.lua for the
 * full rationale (a JS `JSON.parse`/`JSON.stringify` bridge across the
 * wasmoon boundary produces non-table decode results that fail fen's
 * `(= (type value) :table)` gates, breaks `pairs()` iteration, and turns
 * a JSON `null` into a JS `null` that crashes wasmoon's promise-marshalling
 * `.then` probe on the first `"content":null` stream delta) and API
 * surface (`encode`, `decode`, `null`, `empty_array`, `array_mt`,
 * `decode_array_with_array_mt`).
 */
/**
 * fen.util.process: no OS process access exists in-VM. `monotonic-ms` is
 * wired to a real wall clock (`performance.now` via `__fen_host.now_ms`,
 * per fen-web#16 decision item 6 -- reload diagnostics need a real clock,
 * not `os.clock`). `sleep-ms` is a no-op: nothing to block on
 * cooperatively here, but note this means any caller that busy-loops on
 * `sleep-ms` expecting real elapsed delay (rather than treating it purely
 * as a cooperative yield point) will hot-spin instead of pacing -- fine
 * for fen's current callers (best-effort backoff dressing), but a real
 * `setTimeout`-backed async sleep would be needed if that assumption
 * ever changes.
 *
 * Field list mirrors fen.util.process's actual export table exactly (see
 * fen/packages/util/src/fen/util/process.fnl:420-426): `read-pipe-coop`,
 * `read-pipe-close`, `start-captured`, `run-captured`, `monotonic-ms`,
 * `sleep-ms`, `setenv!`. There is no `run` field on the real module; a
 * stub inventing one would silently paper over a caller using an API
 * that doesn't exist there.
 */
export const PROCESS_STUB_LUA = `
local function unsupported(name)
  return function()
    error("fen.util.process." .. name .. " is not supported in the browser VM (no OS process access)")
  end
end
return {
  ["monotonic-ms"] = function() return __fen_host.now_ms() end,
  ["sleep-ms"] = function(_ms) return nil end,
  ["run-captured"] = unsupported("run-captured"),
  ["start-captured"] = unsupported("start-captured"),
  ["read-pipe-close"] = function(_p, _yield) return "" end,
  ["read-pipe-coop"] = unsupported("read-pipe-coop"),
  ["setenv!"] = function(_k, _v) return nil end,
}
`;

// Names always preloaded unless the caller overrides them via opts.preload.
// `cjson` is intentionally NOT eagerly loaded from disk here: it is only
// read when a caller omits it (Node), through the lazy dynamic import in
// createFenRuntime, so importing this module (and @fen-web/runtime) in a
// browser bundle never touches node:fs. Browser callers pass their own
// bundled `cjson` preload.
export const BUILTIN_PRELOAD_LUA: Record<string, string> = {
  "fen.util.process": PROCESS_STUB_LUA,
};
