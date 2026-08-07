# Seams

**Interfaces in fen, implementations here.** The `fen/` submodule is pinned
to tagged releases, never `main`. fen owns every contract (HTTP backend
interface, headless agent API, wire event schema, tool/extension
registration); fen-web owns only fulfillments. If a need can't be met by
implementing an existing seam, that's a request to widen the seam in fen —
never a patch to fen-web's copy of core.

## Seams consumed

| Seam | fen contract | fen-web fulfillment |
|---|---|---|
| HTTP backend | `fen/packages/util/src/fen/util/http/backend.fnl` — `{:request (fn [opts])}`, 11-line interface | `packages/bindings/fnl/fen/util/http/backends/fetch.fnl` over `host.fetch`; see [../bindings/fetch.md](../bindings/fetch.md) |
| Session backend | `fen/packages/core/src/fen/core/extensions/register/session_backend.fnl` — `open/open-existing/append/close/load/find/list/latest` | Implemented: `:kv` backend over `host.kv`, issue #14 (closed); see [../platform/sessions.md](../platform/sessions.md) |
| Config storage | `fen/packages/core/src/fen/core/storage/backend.fnl` — `read/write!` for resolved config documents | Implemented: `fen.core.storage.backend` is preloaded by `packages/runtime` over synchronous `host.kv`; `fen.core.settings` and `fen.core.llm.models` no longer need global filesystem patches |
| Path/VFS probes | `fen/packages/util/src/fen/util/path/backend.fnl` — `getenv/stat/list-dir/pwd-physical` | Implemented: `fen.util.path.backend` is preloaded by `packages/runtime`; API-key `path.getenv` resolves through `env/apikey/<NAME>` and browser probes use safe fallbacks |
| Tool registry | `fen/packages/core/src/fen/core/extensions/register/tool.fnl` — `api.register :tool` with `{:name :description :parameters :exposure :execute}` | Implemented: browser-native read/edit/write/find/grep/ls registered under builtin-tools' names, issue #4 (closed); see [../platform/tools.md](../platform/tools.md) |
| Presenter | `fen/extensions/adapters/presenters/web/manifest.fnl` (existing server-side web presenter) — compositional panel/fragment model | Implemented: DOM presenter over `host.dom-apply` (`apps/web/fnl/fen_web/web`) reusing the same panel/fragment model, issue #6; see [../apps/web.md](../apps/web.md) and [../bindings/dom.md](../bindings/dom.md) |
| Reload/loader | `fen/packages/core/src/fen/core/extensions/loader/reload.fnl`, `discover.fnl`, `manifest.fnl` | Reused with substitutions; see [../runtime/reload.md](../runtime/reload.md) |

## Installation pattern

Seams are filled by pre-setting `package.loaded["<module>"]` from the
runtime bootstrap before the rest of core requires it — not by patching
the fen file. This is the same mechanism `fen.testing.stub-http!` uses
(`fen/packages/testing/src/fen/testing/init.fnl:100`). The v0.17 path and
config-storage fulfillments use this mechanism directly:
`fen.util.path.backend` and `fen.core.storage.backend` are selected before
`fen.core.settings`/`fen.core.llm.models` load.

The browser still has one deliberately narrower global shim for direct POSIX
operations that are not v0.17 module seams: the web boot may install
`fen_web.shims.fs_kv` for the direct Codex auth keychain's POSIX auth.json
reads/writes and for durable JSONL diagnostics. Those globals have no v0.17
module seam yet; the headless integration path does not load the keychain and
does not install the shim.

## What is not a seam

Native modules and POSIX helpers that are not selected by a browser seam
(`fen.util.process`'s unsupported process operations, `io.popen`, shelling
out, and the default POSIX path/storage backends) still remain host
assumptions. They are fulfilled only where a real seam exists: process/clock,
path, and config storage are preloaded by the runtime; browser tools and
sessions use explicit kv bindings.

The browser must not patch a core module's globals merely because the default
backend uses them. The v0.17 storage/path migrations are the concrete example:
`core/settings.fnl` and `core/llm/models.fnl` now go through their injected
backends. The direct Codex auth keychain and optional diagnostic JSONL paths
retain the `fs_kv` global compatibility shim described above.

## Upstream asks

Review of the landed bindings/runtime work (commit `02f4b1a`) surfaced
gaps in fen's own contracts, filed as issues in `acmiyaguchi/fen` rather
than worked around locally, per the "widen the seam in fen" rule above:

- [fen#467](https://github.com/acmiyaguchi/fen/issues/467) — contract
  tests for the HTTP backend interface (`backend.fnl`), so a new backend
  like `fetch.fnl` has something authoritative to test against instead of
  reverse-engineering the native backend's behavior.
- [fen#468](https://github.com/acmiyaguchi/fen/issues/468) — reload
  injectability: `loader/reload.fnl`'s `compiler.fnl`/`discover.fnl`/
  `manifest.fnl`/`checksum.fnl` pieces need to be swappable without the
  three substitutions fen-web currently carries as forked copies (see
  [../runtime/reload.md](../runtime/reload.md)).
- [fen#469](https://github.com/acmiyaguchi/fen/issues/469) — timeout
  defaults (600000/30000/60000ms) currently live only in the native C
  backend and fen-web's `fetch.fnl` `translate`; hoist them into
  `fen.util.http.init` as the single source of truth.
- [fen#470](https://github.com/acmiyaguchi/fen/issues/470) — cjson
  contract: document (or test) the exact `encode`/`decode`/`null`/
  `empty_array`/`array_mt`/`decode_array_with_array_mt` surface fen's core
  actually depends on, so alternate implementations (like
  `packages/runtime/vendor/cjson_stub.lua`) aren't reverse-engineered from
  call sites.
- [fen#471](https://github.com/acmiyaguchi/fen/issues/471) — backend
  capability declaration: a way for an HTTP backend to state whether it
  supports blocking (non-yield) calls, so callers like `fen.update` can
  detect a cooperative-only backend (see [../bindings/fetch.md](../bindings/fetch.md))
  instead of hard-hanging.
- [fen#481](https://github.com/acmiyaguchi/fen/issues/481) — module-load-time
  `io.popen` in the Codex provider's User-Agent detection is an embedding
  hazard: it crashes on a nil `io.popen` (wasmoon has none) before the
  module's own already-documented fallback can apply. Found via the live
  Codex e2e harness; see [../integration.md](../integration.md).
- [fen#482](https://github.com/acmiyaguchi/fen/issues/482) — verify the
  OpenAI adapter's `finish_reason: null` handling under a real lua-cjson
  truthy-`null`-sentinel decode, filed from fen-web's own
  [issue #17](https://github.com/acmiyaguchi/fen-web/issues/17); see
  [../runtime/boot.md](../runtime/boot.md)'s cjson stub section for the
  fen-web-side hazard this mirrors.
- [fen#492](https://github.com/acmiyaguchi/fen/issues/492) — provider
  extra-headers / browser-direct seam so Anthropic's
  `anthropic-dangerous-direct-browser-access` opt-in header can be set from
  the provider layer instead of fen-web's HTTP transport backend
  (`packages/bindings/fnl/fen/util/http/backends/fetch.fnl`), which carries
  it as an interim host-keyed special-case; see [../bindings/fetch.md](../bindings/fetch.md).

See also: [fennel-first.md](fennel-first.md),
[../runtime/module-loading.md](../runtime/module-loading.md).
