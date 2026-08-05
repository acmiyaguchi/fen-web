# fen-web

Browser-resident form of [fen](https://github.com/acmiyaguchi/fen): a Fennel→Lua coding agent running in-page via wasmoon (Lua 5.4 in WASM).
Tracks [fen#99](https://github.com/acmiyaguchi/fen/issues/99).

Two delivery shapes share one core:

- **`apps/demo`** — self-contained single page: IndexedDB-backed virtual FS, sandboxed iframe preview the agent can drive (query/click/fill/assert), BYO API key.
- **`apps/extension`** — MV3 browser extension: cross-origin fetch and real tab/DOM access via a background service worker and content scripts (trails the demo; see fen#100).

## Architecture

**Fennel-first.** TypeScript is an FFI vocabulary, not an application layer.
All policy, logic, tools, and rendering live in Fennel inside the wasmoon VM; JS provides only a small set of host primitives:

| Primitive | Role |
|---|---|
| `host.fetch` | HTTP backend seam (streaming via `getReader()` into fen's SSE parser) |
| `host.kv` | IndexedDB get/put/delete/cursor — virtual-FS substrate |
| `host.dom-apply` | Batched DOM mutations/queries (page, iframe, offscreen doc) |
| `host.msg` | `chrome.runtime` messaging (extension form) |
| `host.ext` | Guarded proxy to specific `chrome.*` namespaces (extension form) |

What irreducibly stays JS/TS: MV3 service-worker top-level (synchronous listener registration), content scripts, the primitive bindings, manifests, and HTML shells.
Litmus test for a new TS file: synchronous-registration constraint, foreign execution context, or primitive — otherwise it's Fennel.

**Interfaces in fen, implementations here.** The `fen/` submodule is pinned to tagged releases, never `main`.
fen owns every contract (HTTP backend interface, headless agent API, wire event schema, tool/extension registration); this repo owns only fulfillments.
If a need can't be met by implementing an existing seam, that's a request to widen the seam in fen — never a patch to core here.

## Layout

```
fen/                    # submodule, pinned to a fen release tag
packages/bindings/      # TS host primitives (host.fetch, host.kv, host.dom-apply, ...)
packages/runtime/       # wasmoon boot: mount fen core, Fennel bootstrap, host table wiring
apps/demo/              # single-page demo (HTML shell + fnl/ tree)
apps/extension/         # MV3 extension (manifest + fnl/ tree)
```

## Phase 1 (bootstrap)

1. Repo scaffold with workspaces as above.
2. Wasmoon boot mounting the pinned submodule's `packages/core`.
3. Primitive bindings (`host.fetch`, `host.kv` at minimum).
4. One headless agent turn against a stub provider.

Soft dependency on fen#175 (headless agent API): the bootstrap drives `fen.core.agent` directly and adopts the formal API when it lands.

## Development

Toolchain is managed by Nix: `nix develop` (or `direnv allow` once) provides Node, Lua 5.4, Fennel, Busted, and lua-cjson.
CI runs everything through the same flake (`nix develop -c ...`) so local and CI toolchains cannot drift.

## Auth

BYO-key only — keys live in IndexedDB (demo) or `chrome.storage` (extension) and never leave the browser.
Anthropic direct-from-page calls use `anthropic-dangerous-direct-browser-access`.
No key-proxy infrastructure is a hard non-goal.

## Non-goals

- No JS/wasm toolchain in `acmiyaguchi/fen`; the web variant lives here.
- Not replacing the desktop TUI; ARMv7/termbox2 stays fen's canonical artifact.
- No server-hosted API key proxy.
- No iframe browsing of arbitrary sites (extension form handles cross-origin).
- No in-browser git client; forge pushes go over REST (`createCommitOnBranch` / Git Data API / GitLab commits API).
