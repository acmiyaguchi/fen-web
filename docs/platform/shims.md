# Platform shims

[Issue #15](https://github.com/acmiyaguchi/fen-web/issues/15).
`fen.util.process` and `cjson` landed with `packages/runtime` (commit
`02f4b1a`, see [../runtime/boot.md](../runtime/boot.md)'s "Built-in
preload stubs"). The v0.17 clock, path, and config-storage seams are also
fulfilled by runtime preloads. `fs_kv` remains only for direct POSIX IO in
web paths that have not yet acquired a module seam.

## Needed shims

| fen dependency | Source/seam | Browser fulfillment |
|---|---|---|
| `fen.util.process` (native `fen_process`) | agent latency/retry process calls | Implemented in `packages/runtime` — unsupported process operations fail clearly; see [../runtime/boot.md](../runtime/boot.md) |
| `fen.util.clock.backend` | v0.17 monotonic clock and cooperative sleep seam | Implemented in `packages/runtime` — `performance.now()` via `host.now_ms`; sleep is a no-op yield point |
| `fen.util.path.backend` | v0.17 path/VFS seam, including `path.getenv` | Implemented in `packages/runtime` — API-key names resolve from `host.kv`; probes return browser-safe fallbacks |
| `fen.core.storage.backend` | v0.17 config-document storage seam | Implemented in `packages/runtime` — settings/models bytes read and written through synchronous `host.kv` |
| `os.time`/`os.date`/`os.clock` timestamps | `fen/packages/core/src/fen/core/types.fnl`, `fen/packages/core/src/fen/core/tools.fnl` | Not shimmed — wasmoon's Lua 5.4 stdlib provides the needed in-VM clock functions |
| `fen.util.random` (native module) | — | Planned — `crypto.getRandomValues` |

The important v0.17 change is that `fen.core.settings` no longer calls
`io.open`/`os.rename` itself: it calls `fen.core.storage`. Likewise,
`fen.core.llm.models` reads its document through `fen.core.storage` and
resolves environment-variable-shaped API keys through `fen.util.path.getenv`.
The runtime preloads those two backend modules before any core module loads,
so browser boot does not need a global filesystem or environment monkeypatch
for configuration or API-key lookup.

## `fen_web.shims.fs-kv`

`packages/platform/fnl/fen_web/shims/fs_kv.fnl` is no longer the settings or
models fulfillment. It remains necessary for the browser's direct Codex auth
keychain, which is in the OpenAI extension tree and still uses POSIX globals:

- `os.getenv(name)` → `nil`. This preserves the env-less HOME/XDG/FEN_AUTH_DIR
  fallback used by the browser seed (`//.config/fen/auth.json`) and prevents
  UI-writable kv content from setting process/debug flags. API-key lookup is
  no longer handled here; it uses `fen.util.path.getenv`.
- `io.open(path, "r")` → `kv.get(path)`, with a missing-key error;
  `io.open(path, "w")` → a buffered truncate handle; and
  `io.open(path, "a")` → a buffered append handle seeded from `kv.get(path)`.
  `:close` commits through `kv.put`; `:flush` remains a deliberate no-op
  because the synchronous kv view has no separate flush operation. Binary
  suffixes are accepted. Update modes return `nil, err`, and malformed modes
  still error clearly.
- `os.remove(path)` → `kv.delete(path)`, retained for temporary auth-file
  cleanup.
- `os.rename(from, to)` → copy to the new kv key and delete the old one,
  retained for the Codex auth keychain's atomic temp-file replacement.
- `os.execute(cmd)` → success for `mkdir -p ...`, which is a no-op over the
  flat kv namespace; every other command returns `nil, "exit", 127` rather
  than claiming that a shell command ran. Codex's best-effort `chmod` call
  and JSONL's directory preparation both pass through this operation.

`fen.util.jsonl.append!` can also reach append IO when the event bus persists
an error, and provider diagnostics have the same shape. These are additional
load-bearing paths, but neither is the reason settings/models use `host.kv`.

`install!(kv)` therefore retains the five global operations only for those
unseamed web paths; the web boot installs it once per VM. The headless
integration script does not install it because its orchestration does not load
the Codex keychain and does not route its collected events through durable
JSONL diagnostics. `snapshot-globals`/`uninstall!` capture and restore all
five globals for unit tests.

**Test-vs-production install-order caveat**: Busted specs must load any real
fen module whose source the Fennel searcher needs before calling `install!`.
The shim's `io.open` cannot read `.fnl` source files after installation.
Production `packages/runtime` reads Fennel sources through its JS-side
`SourceLookup`, so there is no equivalent source-loading hazard at browser
boot.

## Verification against fen v0.17

The v0.17 `fen` submodule, its extension tree, and the fen-web Fennel trees
were searched for every operation that the old shim patched. The result below
distinguishes a target call site made redundant by v0.17 from a separate
browser path that still needs the same global operation.

| Global | Call paths that could reach it in web boot | Disposition |
|---|---|---|
| `os.getenv` | `fen_web.web.boot` used to read the API key; `fen.core.llm.models` and `fen.util.path` now use `path.getenv`; `openai_codex_keychain.fnl` still reads HOME/XDG_CONFIG_HOME/FEN_AUTH_DIR directly | **API-key patch removed as a responsibility, global patch kept.** Web boot now uses `path.getenv`, but Codex's auth path depends on the env-less fallback that browserBoot seeds into kv, so `fs_kv.getenv` must continue returning nil. |
| `io.open` | Default config storage reads/writes files but is defeated by `fen.core.storage.backend`; Codex auth reads/writes `auth.json`; `fen.util.jsonl`/provider diagnostics append files | **Kept.** The settings/models call paths are gone, but Codex read/write and diagnostic append paths still reach the global. The shim keeps r/w/a rather than only append mode. |
| `os.remove` | Default config storage cleanup is defeated by `fen.core.storage.backend`; Codex auth removes a failed temp file; other CLI/extension code is outside normal web boot | **Kept for Codex atomic-write cleanup.** |
| `os.rename` | Default config storage atomic replace is defeated by `fen.core.storage.backend`; Codex auth atomically replaces `auth.json`; other CLI/extension code is outside normal web boot | **Kept for Codex atomic writes.** |
| `os.execute` | `fen.util.path.ensure-dir!` precedes JSONL append; Codex auth creates its directory and attempts chmod; default config/build/CLI paths are otherwise outside normal web boot | **Kept.** `mkdir -p` is a harmless kv no-op and other commands fail. |

The actual redundant work removed by this issue is the settings/models/API-key
premise and integration install: configuration now uses the two v0.17
preloaded seams, web boot resolves its provider key with `path.getenv`, and
`packages/integration/src/turnScript.fnl` no longer installs a VM-wide shim it
does not use. The retained patches are justified by direct extension call
paths, not by the old core call sites.

The browser-native file tools do not use these globals: they register
`read`/`write`/`edit`/`find`/`grep`/`ls` over `fen_web.tools.vfs`, and they do
not register fen's shelling-out `bash` tool.

## Blast radius

The web boot now has explicit module seams for core configuration and
credentials, while the remaining global shim is limited to direct POSIX
extension paths:

1. `fen.core.storage.backend` owns settings/models document bytes.
2. `fen.util.path.backend` owns path probes and API-key environment lookup.
3. `fs_kv.install!` owns direct Codex auth IO plus optional diagnostic IO.

| Module/path | Global or seam | Effect in browser boot |
|---|---|---|
| `fen.core.settings` | `fen.core.storage` | Settings JSON round-trips through `host.kv`; no `io.open`/rename patch is involved. |
| `fen.core.llm.models` | `fen.core.storage`, `fen.util.path.getenv` | Models JSON and API-key references resolve through `host.kv`; no `io.open`/`os.getenv` patch is involved. |
| `fen.util.path` | `fen.util.path.backend` | `HOME`/XDG/PWD and browser path probes use host-provided fallbacks; API-key names use `env/apikey/<NAME>`. |
| `fen.extensions.provider_openai.openai_codex_keychain` | retained `os.getenv`, `io.open`, `os.remove`, `os.rename`, `os.execute` | Auth path reads and atomic writes use the kv-backed compatibility layer; browserBoot's seeded `auth.json` is visible. |
| `fen.core.extensions.events` → `fen.util.jsonl` | retained `io.open "a"`, `os.execute` | The append path is exercised but not durable today: `jsonl.append!` holds its handle open across calls and fs_kv commits only on `:close` (`:flush` is a no-op), so nothing persists through this path — the patches keep it error-free, not durable. |
| provider diagnostics / `fen.util.log_sink` | retained append/write IO when explicitly enabled | Optional diagnostic sink; not part of normal Anthropic boot. |
| POSIX storage/path/discovery/checksum/build/CLI backends | direct POSIX globals | Most are source-map/preload-selected out of normal web boot. |
| browser file tools | explicit `fen_web.tools.vfs` kv calls | No global filesystem operation; virtual files use the `fs:` keyspace. |

## Host IO profiles and issue #22

Tracked as [issue #22](https://github.com/acmiyaguchi/fen-web/issues/22),
filed before fen v0.17 introduced the storage/path seams. The v0.17 work
shrinks the issue substantially: settings and API-key lookup no longer need a
global IO profile, but Codex auth and optional diagnostics still do.

Two runtime environments still exist for those POSIX-shaped operations:

- **`browser-kv`** — the runtime preloads `fen.core.storage.backend` and
  `fen.util.path.backend` over `host.kv`; the web boot also installs `fs_kv`
  for the direct Codex auth keychain and optional diagnostics. Browser file
  tools and sessions always use explicit kv APIs.
- **`node-passthrough`** — `fs_kv` is not installed; real files are mounted
  into wasmoon's MEMFS for the Codex keychain harness, so fen's unmodified
  POSIX IO can read those mounted bytes. See [../integration.md](../integration.md)
  and [issue #18](https://github.com/acmiyaguchi/fen-web/issues/18).

Mixing the profiles can still make mounted auth reads and kv-backed writes
observe different stores. Therefore #22 should be **shrunk, not closed**: it
no longer needs to govern settings or API-key selection, but an explicit
profile/guard remains useful for Codex authentication and diagnostic code that
intentionally exercises POSIX-shaped IO.

## Mechanism

The config/path fulfillments use the normal `package.loaded` preload seam,
installed by `packages/runtime` before core requires them. This is the same
mechanism as the HTTP backend and avoids patching fen source files.

The remaining `fs_kv` shim is different because `io` and `os` are Lua stdlib
globals rather than required modules. Its global scope is intentionally
limited to the direct extension paths verified above; a future fen version
bump should re-run that call-path check before removing or adding a patch.

See also: [../bindings/kv.md](../bindings/kv.md),
[../runtime/boot.md](../runtime/boot.md),
[../runtime/reload.md](../runtime/reload.md),
[../architecture/seams.md](../architecture/seams.md).
