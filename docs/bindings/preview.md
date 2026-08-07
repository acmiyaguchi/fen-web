# preview (`host.preview`)

The sandboxed-iframe preview seam (fen-web#8): the agent drives the app it
just built in the virtual FS. Status: implemented in
`packages/bindings/src/preview` (TS primitive) and
`apps/web/fnl/fen_web/web/preview` (Fennel policy + tools). This is the
differentiator from fen#99 — a coding agent that can *run* and inspect its
own output, not just write files.

## Why a dedicated primitive, not host.dom-apply

`host.dom-apply` ([dom.md](dom.md)) is a synchronous, same-page DOM surface
the presenter owns. The preview is a *different* execution context — a
sandboxed iframe rendering user-generated code — reached only over an
asynchronous `postMessage` RPC. One mechanism per job: mixing the two would
either leak the security boundary into the presenter's DOM ops or force the
preview through a synchronous surface it can't honor. So the preview is its
own primitive with its own poll bridge.

## Security invariant (load-bearing)

The iframe is created with `sandbox="allow-scripts"` and **never**
`allow-same-origin`. User JS in the preview therefore runs in an opaque
origin and cannot reach the parent frame's virtual FS, the API key
(`env/apikey/<VAR>` in IndexedDB), or any forge token. The only channel is
this RPC surface, which:

- carries only command arguments outbound (selectors, values, JS
  expressions) — **never** any secret;
- trusts an inbound message only when `event.source === iframe.contentWindow`
  (unforgeable window identity). Origin is *not* usable as an allowlist key
  because a sandboxed frame reports origin `"null"`; source identity is the
  real guard.

This invariant must not be relaxed to fix a preview capability gap — widen
the RPC surface instead. `packages/bindings/src/preview/webHostPreview.test.ts`
asserts the sandbox attribute (no `allow-same-origin`) and that a reply from
any foreign window source is rejected; `apps/web/tests/preview_test.fnl`
asserts the page assembler never emits the stored API key.

## Op surface

`host.preview` hangs the following functions off `__fen_host`
([host-protocol.md](host-protocol.md)):

| host fn | role |
|---|---|
| `preview_set_html(html)` | render `html` into the iframe (`preview_refresh`); creates the `<iframe sandbox="allow-scripts">` on first use |
| `preview_rpc_start(req)` | begin one RPC (`{method, selector?, value?, expr?}`); returns a numeric id, non-blocking |
| `preview_rpc_poll(id)` | `{done, result?}` — `result` is `{ok, value?, error?}` once the iframe replies; arbitrary non-string `value` payloads are JSON text before the result crosses into Lua |
| `preview_rpc_dispose(id)` | drop terminal state for a completed RPC (mandatory cleanup) |
| `preview_console_drain()` | synchronously drain iframe console/error entries since the last drain or `preview_set_html` |
| `preview_console_uncaught_count()` | count unread uncaught errors without draining (used for terse auto-surfacing markers) |

### RPC result JSON-text boundary

`preview_rpc_poll` is a Wasmoon host seam, so an iframe result's arbitrary
object/array value must never cross into Lua as a JavaScript object. The real
`WebHostPreview`, `FakePreview`, and the `boot.ts` host table all enforce the
same contract: string values remain unquoted tool text, while every other
present value is `JSON.stringify`-ed into text before Lua sees it. An absent
value remains absent and is rendered as `null` by the Fennel tool wrapper.
`rpc-result->tool` accepts only this text/absent shape; it deliberately rejects
other host values rather than handing proxy userdata to cjson. This keeps the
human-visible JSON text for query/click/fill/screenshot and object-valued eval
unchanged while making the JS/Lua boundary safe.

The RPC is asynchronous (a round trip to another context), so — like
`host.fetch` — the Fennel side starts, polls, and yields the turn coroutine
between polls rather than passing a callback that would resume Lua across a
C-call boundary:

```fennel
(let [id (host.preview_rpc_start {:method :query :selector "#app"})]
  (var result nil)
  (while (not result)
    (let [poll (host.preview_rpc_poll id)]
      (if poll.done
          (do (host.preview_rpc_dispose id) (set result poll.result))
          (yield-fn))))
  result)
```

Parity with `host.fetch` is not total, and the Fennel side owns the
difference. `host.fetch` bounds itself with host-side timeouts that the JS
transport surfaces as `poll.done + error`; `host.preview`'s poll has **no**
host-side timeout and returns `{done:false}` forever if the iframe never
replies. A blank iframe (created by driving a `preview.*` tool *before*
`preview_refresh`, so `srcdoc` is never set) has no responder, so its RPCs
never answer. To keep that from hanging the turn coroutine indefinitely,
`fen_web.web.preview.rpc!` enforces the liveness bound in Fennel — a
wall-clock deadline plus a hard poll ceiling — and surfaces a timeout as the
same `{ok=false, error=…}` shape a real RPC failure uses, so the driving
tool returns a structured tool error instead of yielding forever.

## The `preview.*` tools

Registered demo-only through the per-owner manifest loader
(`fen_web.web.boot.load-extension!` on `fen_web.web.preview.manifest`),
via the ordinary public `:tool` register kind — the same path as the file tools.
All seven use `:always` exposure so the agent can drive its app without a
`tool_search` gate.

| tool | effect |
|---|---|
| `preview_refresh` | assemble the vfs tree into one document and `set-html` it into the iframe |
| `preview_query` | `document.querySelectorAll(selector)` → `{count, found, html, text, value}` |
| `preview_click` | click the first match; appends an uncaught-error marker when one is buffered |
| `preview_fill` | set an input's value + dispatch input/change; appends an uncaught-error marker when one is buffered |
| `preview_eval` | evaluate a JS expression in the iframe; appends an uncaught-error marker when one is buffered |
| `preview_screenshot` | a `<canvas>` → `toDataURL()` PNG data URL |
| `preview_console` | drain new console/error entries, including `level`, bounded string `args`, and error `stack` |

`preview_console` drains only entries since the previous `preview_console` call
(or the most recent `preview_refresh`). Refresh starts a fresh iframe document
and clears the unread cursor. The host retains at most 200 entries;
each entry has at most 20 arguments, each argument is capped at 800 characters,
and an error stack is capped at 3,200 characters. Before crossing into Lua, the
host serializes the drain as JSON text capped at 65,536 characters, retaining
newest entries and appending a final synthetic warning with the omitted count
when older entries do not fit. The host retains a bounded recent tail separately
for diagnostics bundles (the bundle includes at most the last 25 entries), so
reading the tool does not erase the **Preview console (tail)** diagnostics
section.

The click/fill/eval marker is a best-effort peek taken around the RPC reply.
Its absence must **not** be interpreted as proof that the preview had no errors:
an error can be posted after the reply is handled. Use `preview_console` for the
authoritative, consuming answer.

## The iframe harness

`fen_web.web.preview.html.build-page` inserts a dependency-free harness into
every assembled document — including the missing-entry placeholder — after the
existing doctype and charset metadata when present, but before the first app
script. It wraps `console.log`, `warn`, `error`, `info`, and `debug`, plus
`window.onerror` and `unhandledrejection`. Arguments are defensively
stringified (circular values and DOM nodes are safe), capped per entry, and
posted to the parent as bounded entries. The host-side aggregate returned by
`preview_console_drain` is bounded to 65,536 serialized characters as described
above. Console property accessors preserve
the capture wrappers when an app replaces an individual console method. The
harness never calls into Lua; `preview_console` reads the host's already-buffered
messages synchronously. The TypeScript doubles expose one synthetic-input seam,
`recordConsole(entry)`, for tests; there is no second `pushConsole` alias.

## Rendering the IndexedDB tree

`preview_refresh` is application policy, so it lives in Fennel
(`fen_web.web.preview.html`). The iframe has no network reach and no
same-origin, so it can't resolve relative `<link>`/`<script src>` URLs;
`build-page` inlines same-tree stylesheet and script references from the vfs
into one self-contained document (absolute URLs are left untouched). The TS
primitive only sets the resulting `srcdoc` and injects the RPC responder
(`packages/bindings/src/preview/responder.ts`), which runs inside the iframe
— the one foreign-execution-context piece that must be TS.

## Implementations

- **`WebHostPreview`** (`webHostPreview.ts`) — over the real `document`/
  `window`; owns the iframe and the message-source-validated poll bridge.
  Injectable `document`/`window`/`mountId` so it's testable off-DOM (there is
  no jsdom in this repo). The browser wires it in
  `apps/web/src/browserBoot.ts` under the `#fen-preview` mount.
- **`FakePreview`** (`fakePreview.ts`) — a synchronous in-memory double for
  Node tests, the way `ScriptedFetch`/`FakeDom` stand in for their bindings.
  The Fennel side has a parallel table-backed double in
  `apps/web/tests/preview_test.fnl`.

See also: [host-protocol.md](host-protocol.md), [dom.md](dom.md),
[../apps/web.md](../apps/web.md),
[../architecture/fennel-first.md](../architecture/fennel-first.md).
