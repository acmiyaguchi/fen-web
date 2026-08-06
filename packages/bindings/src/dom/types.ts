// host.dom-apply: a batched DOM mutation/query surface (see the fen-web
// architecture table in the top-level README). The Fennel DOM presenter
// (apps/web, fen-web#6) computes a fragment diff each frame and hands the
// resulting mutation list to `host.dom-apply` as ONE batched call, plus a
// separate query call to drain user-input events. No layout, styling, or
// diff policy lives in TS — that stays in Fennel, mirroring how host.kv
// keeps filesystem semantics out of the binding.
//
// Why batched, not per-mutation calls: every Lua->JS host call crosses the
// wasmoon boundary. The presenter already knows the whole frame's mutation
// list, so it sends it once and the JS side walks it synchronously. Unlike
// host.fetch, DOM operations are synchronous and never stream, so there is
// no poll/coroutine bridge here (see docs/bindings/host-protocol.md for why
// fetch needed one): `apply` returns its per-op results immediately.
//
// Elements are addressed by a stable string `id`. The presenter assigns
// deterministic ids (fen-row-3, fen-status-model, ...) and owns which ids
// exist via its own committed model, so the op vocabulary needs no selector
// engine — only create/remove and update-by-id.

/** One DOM operation. `op` names the verb; the remaining fields depend on
 * it. All targets are addressed by `id`. */
export interface DomOp {
  op:
    | "create"
    | "remove"
    | "text"
    | "class"
    | "attr"
    | "prop"
    | "focus"
    | "listen"
    | "get"
    | "exists"
    | "drain-events";
  /** Target element id (all ops except drain-events). */
  id?: string;
  /** create: element tag name (e.g. "div", "textarea"). */
  tag?: string;
  /** create: id of the parent element to attach under. */
  parent?: string;
  /** create: id of an existing sibling to insert before (else appended). */
  before?: string;
  /** create/text: textContent to set. */
  text?: string;
  /** create/class: full className string to set. */
  class?: string;
  /** attr/prop/get: attribute or property name. */
  name?: string;
  /** attr: value to set (nil removes the attribute). prop: value to assign. */
  value?: string | number | boolean;
  /** listen: DOM event type to subscribe to (e.g. "submit", "click"). */
  event?: string;
}

/** A user-input event queued by a `listen` op, drained via `drain-events`. */
export interface DomEvent {
  /** id of the element the listener was attached to. */
  id: string;
  /** DOM event type ("submit", "click", ...). */
  event: string;
  /** The dispatch-time `value` of the element the listener is attached to,
   * or "" when it has none. Note a `<form>` submit reports "" here (the
   * form element itself has no `value`), so the presenter reads an input's
   * text with an explicit `get` op rather than relying on this field for
   * submit events. */
  value: string;
}

/** Result of a single op, positionally aligned with the input ops. Mutation
 * ops return `true`; `get` returns the property value (or "" when absent);
 * `exists` returns a boolean; `drain-events` returns the queued events. */
export type DomResult = boolean | string | number | DomEvent[];

/** The host.dom-apply primitive: apply a batched op list, return per-op
 * results. Synchronous. */
export interface HostDomApply {
  apply(ops: DomOp[]): DomResult[];
}
