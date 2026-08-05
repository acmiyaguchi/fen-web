# Runtime boot

Implemented in `packages/runtime` (landed on `main` at commit `02f4b1a`,
after two review/fix rounds; closes issue #1). Entry point:
`packages/runtime/src/index.ts`'s `createFenRuntime`.

## `createFenRuntime(opts)`

```ts
createFenRuntime({
  sources: SourceLookup,       // Map<modname, {lang, src}> or (name) => FenSource | undefined
  host?: Record<string, unknown>,
  preload?: Record<string, PreloadEntry>,
  fennelSource?: string,
}) => Promise<FenRuntime>
```

Boot sequence: create a wasmoon `LuaEngine` → set `__fen_host` (caller's
`host` merged over `defaultHost()`, which supplies `now_ms:
performance.now()`) → load the vendored Fennel 1.6.0 source and register
it under `package.preload["fennel"]` → install built-in preloads
(`cjson`, `fen.util.process`, see below) plus any caller `preload`
entries (caller wins on key collision) → insert the custom source
searcher at `package.searchers[2]` (after the preload searcher, before
the normal path searchers, so preloads always win and the searcher only
fires on a miss).

`opts.sources` is a `SourceLookup`: either a `Map<string, FenSource>`
(`{lang: "fnl"|"lua", src}`) or a resolver function — Node tests build the
map via `loadFenTree` (`packages/runtime/src/sources.ts`), which walks
directory trees and handles `init.fnl`/`init.lua` → package-name
collapsing (e.g. `llm/init.fnl` → `fen.core.llm`); the browser is
expected to back the function form with `host.kv`
(see [../bindings/kv.md](../bindings/kv.md)).

On a Fennel compile error, the searcher `error()`s with the Fennel
message instead of returning nil, so `require` surfaces a readable
diagnostic. On a plain miss (module not in `opts.sources`), it returns an
explanatory string rather than a bare nil, since Lua's `require` loop
concatenates every failed searcher's message and a bare miss would
otherwise read as meaningless `/usr/local/share/lua/...` path noise
in-VM.

This runtime always compiles-on-require through the in-VM Fennel compiler
for everything in `opts.sources` — the bundle-time-precompiled-core half
of the [module-loading.md](module-loading.md) hybrid decision is a later
optimization, not yet wired here.

## `FenRuntime` surface

- **`rt.require(modname)`** — `pcall(require, modname)` in the VM,
  rejecting with the Lua/Fennel error message on failure.
- **`rt.doString(code)`** — thin wrapper over `lua.doString`.
- **`rt.uncache(modname)`** — clears `package.loaded[modname]` so the next
  `require` re-resolves. This is the primitive `/reload` builds on:
  single-file reload = uncache the changed leaf + entry point (~300ms);
  full-tree reload = uncache every pulled module (~1.5s), per the #16
  spike numbers in [module-loading.md](module-loading.md). Tracking
  *which* modules were pulled through the searcher is `/reload`'s job, not
  this runtime's — `uncache` only does the uncache half.
- **`rt.createCoroutinePump(fnSource)`** — see below.
- **`rt.close()`** — closes the Lua engine.

## Coroutine pump pattern

`createCoroutinePump(fnSource)` compiles a Lua source string for a
zero-argument function expression, wraps it in `coroutine.create`, and
returns a `CoroutinePump` handle:

```ts
interface CoroutinePump {
  pump(): Promise<string>;   // resumes once; returns coroutine.status ("suspended" | "dead")
  result(): Promise<unknown>; // return value once status is "dead"
}
```

Each `pump()` call does exactly one `coroutine.resume`. Callers decide
when to call it next — after a `setTimeout` tick, a fetch-stream chunk,
etc. `pump()` throws if `coroutine.resume` itself errored, rather than
reporting it as "still suspended." This is the promoted, reusable form of
the pattern `fen/packages/util/tests/http_native_coop_test.fnl` exercises
(`opts.yield` = `coroutine.yield`) and is what the poll-driven fetch
backend ultimately runs inside — see
[../bindings/host-protocol.md](../bindings/host-protocol.md) for the
JS-side half of that bridge and why callbacks can't cross the C-call
boundary directly.

## Reentrancy limitation

`require`, `installPreload`, `uncache`, and `createCoroutinePump` all
stage their arguments through shared, fixed-name Lua globals
(`__req_mod`, `__preload_name`, `__uncache_mod`, ...) before running a
`doString` that consumes them. This is safe under `await`-sequenced usage
— the only pattern this runtime or its tests use — but **not** safe if a
caller fires multiple calls on the same `FenRuntime` concurrently without
awaiting each one: a second call's `lua.global.set` can clobber the
first's staged argument before its `doString` reads it. There is no
internal queueing or locking. Always `await` each call before starting
the next one on a given runtime instance; this also rules out concurrent
`pump()` calls or a `require` racing a `pump()`.

## Built-in preload stubs

Two names are always preloaded (caller `preload` entries with the same
key override them):

- **`cjson`** — `packages/runtime/vendor/cjson_stub.lua`, a pure-Lua
  JSON codec, deliberately *not* a JS `JSON.parse`/`JSON.stringify`
  bridge. A JS bridge across the wasmoon boundary produces decode results
  that aren't real Lua tables and fail fen's `(= (type value) :table)`
  gates and `pairs()` iteration; worse, a JSON `null` decodes to JS
  `null`, which crashes wasmoon's promise-marshalling `.then` probe on
  the first `"content":null` stream delta from a provider. The stub
  implements `encode`, `decode`, `null`, `empty_array`, `array_mt`, and
  `decode_array_with_array_mt` as sentinel-based pure Lua, matching
  lua-cjson's API surface without ever crossing into JS object land.
- **`fen.util.process`** — `PROCESS_STUB_LUA` in
  `packages/runtime/src/stubs.ts`. `monotonic-ms` calls
  `__fen_host.now_ms()` (wired to `performance.now()` by
  `defaultHost()`), matching the #16 decision item that reload
  diagnostics need a real wall clock, not `os.clock`. `sleep-ms` is a
  no-op (nothing to cooperatively block on in-VM; a caller busy-looping
  on it for real elapsed delay will hot-spin — fine for fen's current
  best-effort backoff callers, but would need a `setTimeout`-backed async
  sleep if that assumption changes). `run-captured`/`start-captured`/
  `read-pipe-coop` error clearly as unsupported; `read-pipe-close`
  returns `""`; `setenv!` is a no-op. Field list mirrors
  `fen/packages/util/src/fen/util/process.fnl:420-426` exactly — no
  invented fields.

## Vendored Fennel

`packages/runtime/vendor/fennel-1.6.0.lua`, version pinned to match
`fen/Makefile`'s `FENNEL_VER`
(`packages/runtime/src/vendoredFennel.ts`'s `FENNEL_VERSION` constant). A
test asserts this constant against the Makefile pin so the two can't
silently drift. `loadVendoredFennelSource()` /
`loadVendoredCjsonStubSource()` are Node-only (read from disk via `fs`);
browser builds fetch/bundle the same vendor files and pass their contents
as `opts.fennelSource` / a `cjson` preload override.

See also: [module-loading.md](module-loading.md) for the hybrid decision
this runtime implements the in-VM half of, [reload.md](reload.md) for how
`uncache` gets used, and
[../bindings/host-protocol.md](../bindings/host-protocol.md) for how
`__fen_host` and the coroutine pump connect to `host.fetch`.
