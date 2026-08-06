# dom (`host.dom-apply`)

Batched DOM mutation/query surface — the seam the browser DOM presenter
(`apps/web`, issue #6) renders through. Status: implemented in
`packages/bindings/src/dom`. No layout, styling, or diff policy lives in TS;
that stays in Fennel (`apps/web/fnl/fen_web/web`, see
[../apps/web.md](../apps/web.md)), the same way `host.kv` keeps filesystem
semantics out of its binding.

## Why one batched call, not per-mutation

Every Lua→JS host call crosses the wasmoon boundary. The presenter computes
a whole frame's fragment diff in Fennel, then hands the resulting mutation
list to `host.dom-apply` as **one** call; the JS side walks it
synchronously. Unlike `host.fetch`, DOM operations are synchronous and never
stream, so there is no poll/coroutine bridge here (contrast
[host-protocol.md](host-protocol.md)): `apply` returns its per-op results
immediately.

## Op vocabulary

`packages/bindings/src/dom/types.ts`. Elements are addressed by a stable
string `id`; the presenter assigns deterministic ids (`fen-row-3`,
`fen-status-model`, …) and owns which ids exist via its own committed model,
so the vocabulary needs no selector engine.

| op | fields | effect |
|---|---|---|
| `create` | `id parent tag [before] [text] [class]` | create `<tag id>` under `parent` (before a sibling, else appended); idempotent by id, so `/reload` re-runs are safe. `text`/`class` double as an initial set. |
| `remove` | `id` | remove the element and its subtree (no-op if absent) |
| `text` | `id text` | set `textContent` |
| `class` | `id class` | set `className` |
| `attr` | `id name [value]` | `setAttribute`; a nil value removes it |
| `prop` | `id name value` | assign a DOM property (e.g. input `value`, `disabled`) |
| `focus` | `id` | `element.focus()` |
| `listen` | `id event` | subscribe (idempotently) to a DOM event, enqueuing it for `drain-events` |
| `get` (query) | `id name` | return a property value, or `""` when absent |
| `exists` (query) | `id` | return whether the element exists |
| `drain-events` (query) | — | return and clear the queued input events |

`apply(ops)` returns a per-op result array positionally aligned with the
input: mutation ops return `true`, `get` returns the value (`""` when
absent, never a nil that would truncate a Lua result sequence), `exists`
returns a boolean, and `drain-events` returns the `{id, event, value}`
list.

## Input never calls back into Lua

A `listen` op registers a JS-side handler that **enqueues** an event; it
never resumes the agent coroutine, which would try to yield across a C-call
boundary (the same hazard [host-protocol.md](host-protocol.md) documents for
fetch). The presenter drains the queue poll-style with a `drain-events` op
each frame. Form `submit` events are `preventDefault`-ed so the presenter,
not the browser, owns submission.

## Implementations

- **`WebHostDomApply`** (`packages/bindings/src/dom/webDomApply.ts`) — over
  the real `document`. Wire it into the runtime host table so Fennel calls
  `_G.__fen_host.dom_apply(ops)`:

  ```ts
  const dom = new WebHostDomApply();
  createFenRuntime({ ..., host: { dom_apply: (ops) => dom.apply(normalizeOps(ops)) } });
  ```

  `normalizeOps` (`applyOps.ts`) tolerates wasmoon handing a Lua sequence
  across as either a real array or a 1-based object.
- **`FakeDom`** (`packages/bindings/src/dom/fakeDom.ts`) — in-memory tree
  implementing the same op semantics for Node/Busted tests, the way
  `MemoryKv` mirrors `IndexedDbKv`. `emit(id, event, value)` simulates a
  user event.

Both share the single op dispatcher `applyDomOps(adapter, ops)`
(`applyOps.ts`) so the semantics can't drift between them. The Fennel side
has a parallel table-backed double in `apps/web/tests/support.fnl`.

See also: [host-protocol.md](host-protocol.md),
[../apps/web.md](../apps/web.md),
[../architecture/seams.md](../architecture/seams.md).
