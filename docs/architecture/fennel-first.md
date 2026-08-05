# Fennel-first

TypeScript is an FFI vocabulary, not an application layer. All policy,
logic, tools, and rendering live in Fennel inside the wasmoon VM; JS
provides only host primitives.

## The litmus test

A new file is TS only if it needs one of:

- **Synchronous-registration constraint** — e.g. MV3 service-worker
  top-level listener registration, which must run synchronously at script
  load.
- **Foreign execution context** — content scripts, background service
  worker, HTML shells, manifests.
- **A primitive itself** — the host binding implementation.

Otherwise it's Fennel. This includes: HTTP/session/tool policy, retries,
error shaping, virtual-FS semantics, DOM presenter composition, agent
wiring.

## Host primitive table

| Primitive | Role |
|---|---|
| `host.fetch` | HTTP backend seam (streaming via `getReader()` into fen's SSE parser) |
| `host.kv` | IndexedDB get/put/delete/cursor — virtual-FS substrate |
| `host.dom-apply` | Batched DOM mutations/queries (page, iframe, offscreen doc) |
| `host.msg` | `chrome.runtime` messaging (extension form) |
| `host.ext` | Guarded proxy to specific `chrome.*` namespaces (extension form) |

`host.fetch` and `host.kv` are implemented in `packages/bindings`; see
[../bindings/fetch.md](../bindings/fetch.md) and
[../bindings/kv.md](../bindings/kv.md). `host.dom-apply`, `host.msg`, and
`host.ext` are not yet implemented (planned per apps #6-#9, #11).

## Why this split

Case-name convention marks the boundary too: JS/TS uses camelCase
(`FetchRequestOptions`, `onChunk`), Fennel mirrors fen's kebab-case
(`:timeout-ms`, `:on-chunk`). The Fennel side of each binding
(`fnl/fen/util/http/backends/fetch.fnl` in `packages/bindings`) is the sole
translation point — see
[../bindings/host-protocol.md](../bindings/host-protocol.md).

Keeping policy in Fennel means fen's existing test suites, extension
registry, and reload discipline apply unchanged to fen-web code; only the
primitive bindings are platform-specific.

See also: top-level [README.md](../../README.md) architecture section,
[seams.md](seams.md).
