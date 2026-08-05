import type { DomOp, DomEvent, DomResult } from "./types.js";

// The op dispatcher is written once against a narrow `DomAdapter` so the
// same semantics back both the real-DOM implementation (WebHostDomApply)
// and the in-memory test double (FakeDom). This is the one mechanism that
// interprets the op vocabulary; adapters only translate individual verbs to
// their tree.

/** Backing store the dispatcher drives. All addressing is by element id;
 * the adapter owns id -> node resolution (document.getElementById for the
 * web adapter, a Map for the fake one) so the dispatcher stays tree-shape
 * agnostic. */
export interface DomAdapter {
  exists(id: string): boolean;
  /** Create `<tag id=id>` and attach it under `parentId`, before sibling
   * `beforeId` when given (else appended). */
  create(tag: string, id: string, parentId: string, beforeId?: string): void;
  /** Remove the element and its descendants; no-op when absent. */
  remove(id: string): void;
  setText(id: string, text: string): void;
  setClass(id: string, cls: string): void;
  setAttr(id: string, name: string, value: string): void;
  removeAttr(id: string, name: string): void;
  setProp(id: string, name: string, value: unknown): void;
  getProp(id: string, name: string): unknown;
  focus(id: string): void;
  /** Subscribe (idempotently) to `event` on `id`, enqueuing a DomEvent when
   * it fires. */
  listen(id: string, event: string): void;
  /** Return and clear the queued input events. */
  drainEvents(): DomEvent[];
}

function requireField<T>(op: DomOp, field: keyof DomOp, value: T | undefined): T {
  if (value === undefined || value === null) {
    throw new Error(`host.dom-apply: op '${op.op}' requires field '${String(field)}'`);
  }
  return value;
}

function requireTarget(adapter: DomAdapter, op: DomOp): string {
  const id = requireField(op, "id", op.id);
  if (!adapter.exists(id)) {
    throw new Error(`host.dom-apply: op '${op.op}' targets missing element '${id}'`);
  }
  return id;
}

/** Interpret one batched op list against `adapter`, returning per-op results
 * positionally aligned with `ops`. */
export function applyDomOps(adapter: DomAdapter, ops: DomOp[]): DomResult[] {
  return ops.map((op): DomResult => {
    switch (op.op) {
      case "create": {
        const id = requireField(op, "id", op.id);
        if (!adapter.exists(id)) {
          adapter.create(
            requireField(op, "tag", op.tag),
            id,
            requireField(op, "parent", op.parent),
            op.before,
          );
        }
        // create doubles as an initial-set so a new row is one op, not
        // three: text/class here are optional in-place sets.
        if (op.text !== undefined) adapter.setText(id, op.text);
        if (op.class !== undefined) adapter.setClass(id, op.class);
        return true;
      }
      case "remove":
        adapter.remove(requireField(op, "id", op.id));
        return true;
      case "text":
        adapter.setText(requireTarget(adapter, op), op.text ?? "");
        return true;
      case "class":
        adapter.setClass(requireTarget(adapter, op), op.class ?? "");
        return true;
      case "attr": {
        const id = requireTarget(adapter, op);
        const name = requireField(op, "name", op.name);
        if (op.value === undefined || op.value === null) adapter.removeAttr(id, name);
        else adapter.setAttr(id, name, String(op.value));
        return true;
      }
      case "prop":
        adapter.setProp(requireTarget(adapter, op), requireField(op, "name", op.name), op.value);
        return true;
      case "focus":
        adapter.focus(requireTarget(adapter, op));
        return true;
      case "listen":
        adapter.listen(requireTarget(adapter, op), requireField(op, "event", op.event));
        return true;
      case "get": {
        const v = adapter.getProp(requireTarget(adapter, op), requireField(op, "name", op.name));
        // Normalize absent/undefined to "" so the value never crosses back
        // into Lua as a nil that would truncate a result sequence.
        return v === undefined || v === null ? "" : (v as string | number | boolean);
      }
      case "exists":
        return adapter.exists(requireField(op, "id", op.id));
      case "drain-events":
        return adapter.drainEvents();
      default:
        throw new Error(`host.dom-apply: unknown op '${(op as DomOp).op}'`);
    }
  });
}

/** wasmoon may hand a Lua sequence to a JS host function as a real array or
 * as a plain object with 1-based numeric keys, depending on marshalling
 * config. Normalize both (and a 0-based array) to a real DomOp[] so callers
 * wiring `__fen_host.dom_apply` don't have to. */
export function normalizeOps(ops: unknown): DomOp[] {
  if (Array.isArray(ops)) return ops as DomOp[];
  if (ops && typeof ops === "object") {
    const record = ops as Record<string, DomOp>;
    const out: DomOp[] = [];
    // Lua sequences are 1-based; a JS array-turned-object would still start
    // at "0". Accept either origin.
    let i = record["0"] !== undefined ? 0 : 1;
    while (record[String(i)] !== undefined) {
      out.push(record[String(i)]);
      i++;
    }
    return out;
  }
  return [];
}
