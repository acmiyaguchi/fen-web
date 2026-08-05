# Platform shims

[Issue #15](https://github.com/acmiyaguchi/fen-web/issues/15).
`fen.util.process` and `cjson` landed with `packages/runtime` (commit
`02f4b1a`, see [../runtime/boot.md](../runtime/boot.md)'s "Built-in
preload stubs"). The `os.time`/settings/API-key half lives in
`packages/platform/fnl/fen_web/shims/fs_kv.fnl`, described below.

fen core leaks `os`/`io`/native modules past the HTTP and FS seams. These
block the headless turn (#5) and need small browser shims, preloaded into
`package.loaded` from the runtime bootstrap — same pattern as the HTTP
backend stub in `fen/packages/testing`. Policy stays in Fennel; each shim
is meant to be tiny.

## Needed shims

| fen dependency | Source | Shim |
|---|---|---|
| `fen.util.process.monotonic-ms` (native `fen_process`) | agent latency timing; retry's coop sleep (busy-yield to a monotonic deadline) | Implemented in `packages/runtime` — `performance.now()` via host. Also used by reload diagnostics — see [../runtime/reload.md](../runtime/reload.md) |
| `fen.util.random` (native module) | — | Planned — `crypto.getRandomValues` |
| `os.time`/`os.date`/`os.clock` timestamps | `fen/packages/core/src/fen/core/types.fnl`, `fen/packages/core/src/fen/core/tools.fnl` | Not shimmed — wasmoon's Lua 5.4 stdlib already provides working `os.time`/`os.date`/`os.clock` in-VM (verified against `packages/runtime`'s `createFenRuntime`; the WASM runtime reads a real wall clock without touching host OS syscalls), so there is nothing to override |
| `core/settings.fnl` (`io.open`, `os.remove`) | settings persistence | Implemented — `fen_web.shims.fs-kv` |
| `core/llm/models.fnl` (`io.open`, `os.getenv` for API keys) | model/key config | Implemented — `fen_web.shims.fs-kv`; this is where BYO-key storage (issue #7) plugs in |

`core` only needs `monotonic-ms` from `fen.util.process` — no other method
of that module is required for the headless turn.

## `fen_web.shims.fs-kv`

`packages/platform/fnl/fen_web/shims/fs_kv.fnl`. `core/settings.fnl` and
`core/llm/models.fnl` are large modules with real business logic well
past their IO calls (models.fnl alone is ~640 lines of provider/model
resolution), so rather than reimplementing either module wholesale, this
shim monkey-patches the five Lua globals those two files actually call —
`io.open`, `os.remove`, `os.rename`, `os.execute`, `os.getenv` — so both
modules load and run completely unmodified against `host.kv`, preserving
their public API by construction:

- `io.open(path, "r")` → `kv.get(path)`, `nil, err` on a missing key
  (matching real `io.open`'s missing-file behavior).
- `io.open(path, "w")` → a buffered handle that commits via `kv.put` on
  `:close`.
- `os.remove(path)` → `kv.delete(path)`.
- `os.rename(from, to)` → copies the kv value to `to` and deletes `from`,
  for `settings.fnl`'s atomic-write-then-rename dance.
- `io.open(path, "a")` → a buffered handle seeded from the current
  `kv.get(path)` value, appending on `:write` and committing the whole
  buffer via `kv.put` on `:close` — the append path `jsonl.fnl` uses for
  durable diagnostics.
- Modes real `io.open` recognizes but this shim doesn't implement
  (`"r+"`/`"w+"`/`"a+"`, with or without a trailing `"b"`) return `nil,
  err` rather than throwing — matching the fact that a real update-mode
  open can fail for ordinary, already-handled reasons. A genuinely
  malformed mode string still `error()`s, matching real `io.open`.
- `os.remove(path)` → `kv.delete(path)`.
- `os.rename(from, to)` → copies the kv value to `to` and deletes `from`,
  for `settings.fnl`'s atomic-write-then-rename dance.
- `os.execute(cmd)` → success only when `cmd` matches `^mkdir %-p`
  (`settings.fnl`'s `ensure-dir!`, meaningless over a flat kv namespace
  but harmless to report as done); anything else returns failure (`nil,
  "exit", 127`) rather than falsely claiming a command ran. `io.popen` is
  intentionally left unpatched, so any caller that shells out for
  something this shim doesn't understand fails loudly instead of the VM
  reporting two different lies (a fake success from `os.execute`, a real
  attempt from `io.popen`).
- `os.getenv(name)` → allowlisted: only names shaped like an API-key env
  var (`^[A-Z][A-Z0-9_]*$` ending in `_KEY`/`_TOKEN`/`_SECRET`, or the
  literal `KEY`) are looked up at all, under `kv.get("env/apikey/" ..
  name)`; everything else returns `nil` without ever touching kv. This is
  where issue #7's BYO-key storage writes: setting a provider's API key
  means `kv.put("env/apikey/ANTHROPIC_API_KEY", "...")`, and any
  `models.json` entry whose `apiKey` is that env-var name resolves
  through this. The allowlist exists because `os.getenv` is a shared
  global — without it, UI-writable kv content could drive `FEN_LOG`,
  `FEN_DEV_PATH`, `FEN_TOOL_RESULT_MAX_BYTES`, and every other `FEN_*`
  debug/dev flag fen reads via `os.getenv`, not just API keys.

`install!(kv)` applies all five patches; call it once from runtime
bootstrap before `fen.core.settings`/`fen.core.llm.models` are required
(production-safe — see the ordering caveat below). It asserts
`kv.get`/`kv.put`/`kv.delete` are functions so a misconfigured caller
fails at install time. `snapshot-globals`/`uninstall!` capture and restore
the five patched globals, for tests that install per-case and must not
leak the patch into unrelated specs; production boot has no reason to
call `uninstall!`.

Read/write handles route any method this shim doesn't implement (`:seek`,
`:setvbuf`, ...) through a `__index` metamethod that errors with a clear
"not supported by the kv-backed shim" message instead of Lua's generic
"attempt to call a nil value". By design, a `kv.get(path)` (or a fresh
`io.open(path, "r")`) issued before a write/append handle's `:close`
never sees the buffered-but-uncommitted content — the same visibility a
real buffered `FILE*` has before its own flush/close reaches the OS.

Busted specs (`packages/platform/tests/fs_kv_test.fnl` for the shim in
isolation; `settings_test.fnl`/`api_keys_test.fnl` for the two real fen
modules routed through it) exercise this against a synchronous
table-backed kv (`packages/platform/tests/support.fnl`); production
`host.kv` is async (IndexedDB), so a runtime-side coroutine-pumped bridge
from that async surface to these synchronous call sites — the same
yield-across-C-call-boundary shape `host-protocol.md` documents for fetch
— is `packages/runtime`'s job at boot time, not this module's.

**Test-vs-production install-order caveat**: Busted specs must `require`
the real fen module (against the real, unpatched `io.open`) before
calling `install!`, because Busted's own Fennel searcher reads `.fnl`
source files off disk via `io.open` — installing the shim first makes
*module loading itself* try to fetch the module's source out of the
(empty) test kv. This is a Busted-searcher artifact only: production
`packages/runtime` reads every Fennel source through a JS-side
`SourceLookup` (see [../runtime/boot.md](../runtime/boot.md)), never
through `io.open`, so calling `install!` before the very first `require`
at real boot time is safe — there is no equivalent hazard there.

## Blast radius

`install!` patches `io.open`/`os.remove`/`os.rename`/`os.execute`/
`os.getenv` VM-wide, not just for the two modules issue #15 targets.
Every fen module that touches any of those five globals is affected the
moment the shim is installed. This table is what a fen version bump
should be diffed against (a new `os.getenv`/`io.open` call site in fen
either needs to already be covered here or is a new blast-radius gap):

| Module | Global(s) used | Effect once `fs-kv` is installed |
|---|---|---|
| `fen.core.settings` | `io.open` (`r`/`w`), `os.remove`, `os.rename`, `os.execute` | Intended target — settings.json round-trips through kv |
| `fen.core.llm.models` | `io.open` (`r`), `os.getenv` | Intended target — models.json + apiKey env-var resolution through kv |
| `fen.util.log_sink` | `io.open` (`a`) | Log file sink now appends into kv instead of a real file; append-mode support (this review round) makes this work rather than silently truncating |
| `fen.util.jsonl` | `io.open` (`a`), `:flush` | Diagnostics JSONL append path now writes into kv; `:flush` is a no-op (nothing to flush until `:close` commits) |
| `fen.util.checksum` | `io.open` (`rb`) | Reload-diagnostics file fingerprinting reads through kv instead of disk; `rb` mode works via the binary-suffix strip |
| `fen.util.path` | `os.getenv` (`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `PWD`) | None of these are API-key-shaped, so the allowlist returns `nil` for all of them — `path.fnl`'s hardcoded `/tmp`/`~/.config`/`~/.local/state`/`~/.local/share` fallbacks are what actually take effect, which is what gives `settings.fnl`/`models.fnl` their deterministic kv key paths in tests |
| `fen.util.process` | `os.getenv` (`HOME`, `XDG_STATE_HOME`) | Same as above — allowlist returns `nil`, fallback paths apply |
| `fen.core.extensions.loader.discover`, `fen.core.extensions.loader.reload`, `fen.core.extensions.rocks`, `fen.util.checksum`, `fen.util.log`, `fen.util.text` | `os.getenv` (`FEN_FIRST_PARTY_EXTENSIONS_PATH`, `FEN_EXTENSIONS_PATH`, `FEN_DEV_PATH`, `FEN_ROCKS_TREE`, `LUA`, `FEN_LOG`, `FEN_TOOL_RESULT_MAX_BYTES`) | All `FEN_*`/dev-tooling flags — none API-key-shaped, so all return `nil` regardless of kv content. This is deliberate: these are debug/dev escape hatches, not something UI-writable browser state should ever drive |
| `fen.fen.main`, `fen.fen.runtime`, `fen.fen.update` | `os.getenv` (`FEN_BIN`, `PATH`, `FEN_ARCH`) | CLI-launcher-only concerns not reachable in-VM in the browser runtime at all (these modules aren't part of the `fen.core.agent` require subgraph `packages/runtime` boots); listed for completeness in case that changes |

## Mechanism

Same as the HTTP backend: preload replacement Fennel modules into
`package.loaded` before the rest of core requires them, rather than
patching fen. See [../architecture/seams.md](../architecture/seams.md) for
the general installation pattern (note: these are not registrable seams,
just hard dependencies that need blind substitution). `fs-kv` uses a
variant of this — global monkey-patching instead of a `package.loaded`
substitution — since `io`/`os` are stdlib globals, not `require`d modules.

Blocks [issue #5](https://github.com/acmiyaguchi/fen-web/issues/5)
(headless turn milestone).

See also: [../bindings/kv.md](../bindings/kv.md),
[../runtime/reload.md](../runtime/reload.md).
