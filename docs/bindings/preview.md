# preview (`host.preview`)

The sandboxed-iframe preview seam (fen-web#8): the agent drives the app it
just built in the virtual FS. Status: implemented in
`packages/bindings/src/preview` (TS primitive) and
`apps/demo/fnl/fen_web/demo/preview` (Fennel policy + tools). This is the
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
any foreign window source is rejected; `apps/demo/tests/preview_test.fnl`
asserts the page assembler never emits the stored API key.

## Op surface

`host.preview` hangs four functions off `__fen_host`
([host-protocol.md](host-protocol.md)):

| host fn | role |
|---|---|
| `preview_set_html(html)` | render `html` into the iframe (`preview.refresh`); creates the `<iframe sandbox="allow-scripts">` on first use |
| `preview_rpc_start(req)` | begin one RPC (`{method, selector?, value?, expr?}`); returns a numeric id, non-blocking |
| `preview_rpc_poll(id)` | `{done, result?}` — `result` is `{ok, value?, error?}` once the iframe replies |
| `preview_rpc_dispose(id)` | drop terminal state for a completed RPC (mandatory cleanup) |

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
`preview.refresh`, so `srcdoc` is never set) has no responder, so its RPCs
never answer. To keep that from hanging the turn coroutine indefinitely,
`fen_web.demo.preview.rpc!` enforces the liveness bound in Fennel — a
wall-clock deadline plus a hard poll ceiling — and surfaces a timeout as the
same `{ok=false, error=…}` shape a real RPC failure uses, so the driving
tool returns a structured tool error instead of yielding forever.

## The `preview.*` tools

Registered demo-only through the per-owner manifest loader
(`fen_web.demo.boot.load-extension!` on `fen_web.demo.preview.manifest`),
via the ordinary public `:tool` register kind — the same path the file tools
use, not an ad-hoc registration. All six use `:always` exposure so the agent
can drive its app without a `tool_search` gate.

| tool | effect |
|---|---|
| `preview.refresh` | assemble the vfs tree into one document and `set-html` it into the iframe |
| `preview.query` | `document.querySelectorAll(selector)` → `{count, found, html, text, value}` |
| `preview.click` | click the first match |
| `preview.fill` | set an input's value + dispatch input/change |
| `preview.eval` | evaluate a JS expression in the iframe, return the JSON-serialized result |
| `preview.screenshot` | a `<canvas>` → `toDataURL()` PNG data URL |

## Rendering the IndexedDB tree

`preview.refresh` is application policy, so it lives in Fennel
(`fen_web.demo.preview.html`). The iframe has no network reach and no
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
  `apps/demo/src/browserBoot.ts` under the `#fen-preview` mount.
- **`FakePreview`** (`fakePreview.ts`) — a synchronous in-memory double for
  Node tests, the way `ScriptedFetch`/`FakeDom` stand in for their bindings.
  The Fennel side has a parallel table-backed double in
  `apps/demo/tests/preview_test.fnl`.

See also: [host-protocol.md](host-protocol.md), [dom.md](dom.md),
[../apps/demo.md](../apps/demo.md),
[../architecture/fennel-first.md](../architecture/fennel-first.md).
