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

## In-VM io/os reach a virtual filesystem, not the host

wasmoon's Lua `io`/`os` reach an Emscripten MEMFS virtual filesystem, not
the real filesystem — **even under Node**. `io.open` of a real host path
returns `nil`; `os.getenv("HOME")` reads back the synthetic
`/home/web_user`, not the actual `$HOME`. This is not a browser-only
constraint that Node somehow escapes: wasmoon's WASM Lua build never wires
libc's file/env syscalls to the host process regardless of what's hosting
the VM. `createFenRuntime` does not paper over this or claim otherwise —
`fen.util.process`'s `monotonic-ms`/`sleep-ms`/`setenv!` all deliberately
route through `__fen_host`/no-ops rather than real `os` calls, for exactly
this reason.

This is why the [`fs_kv` platform shim](../platform/shims.md) exists for
`fen.core.settings`/`fen.core.llm.models` — those modules' `io.open`/
`os.getenv` calls are pointed at `host.kv` instead of a filesystem that,
in-VM, wouldn't be real anyway. It's also why the live-Codex harness
([integration.md](../integration.md)) — which needs `openai_codex_keychain.fnl`'s
*real*, unmodified `io.open` reads of `~/.config/fen/auth.json` to work —
has to reach into wasmoon's internal MEMFS object and mount real bytes
onto the VM's virtual path rather than relying on any host passthrough.
First-class mount support (`FenRuntimeOptions` growing a `mounts`/
`environmentVariables` knob wired to wasmoon's `LuaFactory.mountFile`/
`environmentVariables`) is tracked as
[issue #18](https://github.com/acmiyaguchi/fen-web/issues/18) — not yet
implemented; today, mounting is the integration package's own workaround,
not a runtime feature. See also
[platform/shims.md](../platform/shims.md#host-io-profiles) for the two
mutually-exclusive IO strategies (`fs_kv` shims vs. real mounted files)
this split implies.

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

Tracked as [issue #21](https://github.com/acmiyaguchi/fen-web/issues/21):
fine for one turn at a time (which is all `turn.test.ts` and `e2e-codex.mts`
currently do — see [../integration.md](../integration.md)), but becomes a
real constraint the moment a presenter overlaps a turn with `/reload`, a
second session, or tool execution that triggers its own `require`. Fix
direction: thread a unique key per operation (closure-captured table
instead of fixed globals) rather than fixed global names. Should land
before a presenter drives turns interactively.

### Cooperative retry backoff busy-spins the pump

Related, tracked separately as
[issue #20](https://github.com/acmiyaguchi/fen-web/issues/20): fen's
provider retry (`extensions/adapters/providers/shared/retry.fnl`'s
`default-sleep-ms`) implements coop-mode sleep as busy-yield-until-a-
monotonic-deadline. Under this runtime's pump, every `yield` is a resume
tick — a 30s backoff becomes a hot loop resuming the coroutine as fast as
the caller's `pump()` loop allows, burning CPU. The pump needs
backpressure: when a tick makes no progress, the caller should schedule
the next `pump()` via `setTimeout(n)` rather than immediately, or the
runtime needs to honor an optional sleep-hint surfaced from the VM. Same
underlying hazard as `fen.util.process`'s documented `sleep-ms` no-op
(see "Built-in preload stubs" above) — any `while (not done) (sleep-ms
...)` loop hot-spins today.

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
  **Hazard** (correct-but-surprising, matching real lua-cjson): the
  `null` sentinel is a truthy Lua table, so a naive `(when
  choice.finish_reason ...)` check against a decoded `finish_reason:
  null` field is true on every delta, not just the terminal one. This
  bit the OpenAI adapter during the [#5 milestone](../integration.md)
  ([issue #17](https://github.com/acmiyaguchi/fen-web/issues/17)) and may
  reproduce on desktop fen against real lua-cjson too — filed upstream as
  [fen#482](https://github.com/acmiyaguchi/fen/issues/482).
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

## Browser bundling

`createFenRuntime`'s Node-only helpers (`loadVendoredFennelSource`,
`loadVendoredCjsonStubSource`, `loadFenTree`) read from disk via `node:fs`.
So importing `@fen-web/runtime` in a browser bundle never drags `node:fs`
into the executed graph, the runtime keeps all `node:*` usage out of module
top level and defers the disk-backed defaults: `fennelSource` falls back to
a lazy `import("./vendoredFennel.js")` only when the caller omits it, and
the built-in `cjson` preload is disk-loaded only when the caller passes no
`cjson` entry in `opts.preload`. The browser (see
[../apps/demo.md](../apps/demo.md)) always supplies both from bundled raw
text, so those readers never run in-page; the demo's Vite config aliases
the residual `node:*` specifiers (reachable only through the never-taken
lazy `import`) to a throwing stub so Rollup can still resolve them.

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
`uncache` gets used, [../bindings/host-protocol.md](../bindings/host-protocol.md)
for how `__fen_host` and the coroutine pump connect to `host.fetch`, and
[../integration.md](../integration.md) for the two harnesses that exercise
this runtime end to end.
