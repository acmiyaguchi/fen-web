import type { DomAdapter } from "./applyOps.js";
import { applyDomOps } from "./applyOps.js";
import type { DomOp, DomEvent, DomResult, HostDomApply } from "./types.js";

/** Real-`document` implementation of host.dom-apply. Wire it into the host
 * table the runtime installs (see docs/runtime/boot.md) as, e.g.:
 *
 *   const dom = new WebHostDomApply();
 *   createFenRuntime({ ..., host: { dom_apply: (ops) => dom.apply(normalizeOps(ops)) } });
 *
 * so Fennel calls `_G.__fen_host.dom_apply(ops)`. Listeners never call back
 * into Lua (that would try to resume the agent coroutine across a C-call
 * boundary — the same hazard docs/bindings/host-protocol.md documents for
 * fetch); they enqueue events the presenter drains via a `drain-events` op,
 * poll-style. */
export class WebHostDomApply implements DomAdapter, HostDomApply {
  private queue: DomEvent[] = [];
  private listening = new Set<string>();

  constructor(private readonly document: Document = globalThis.document) {}

  apply(ops: DomOp[]): DomResult[] {
    return applyDomOps(this, ops);
  }

  private el(id: string): HTMLElement {
    const node = this.document.getElementById(id);
    if (!node) throw new Error(`host.dom-apply: no element '${id}'`);
    return node as HTMLElement;
  }

  // --- DomAdapter ---

  exists(id: string): boolean {
    return this.document.getElementById(id) !== null;
  }

  create(tag: string, id: string, parentId: string, beforeId?: string): void {
    const node = this.document.createElement(tag);
    node.id = id;
    const parent = this.el(parentId);
    if (beforeId) parent.insertBefore(node, this.el(beforeId));
    else parent.appendChild(node);
  }

  remove(id: string): void {
    this.document.getElementById(id)?.remove();
    // Drop listener bookkeeping for the removed element so a later same-id
    // recreate re-subscribes instead of being wrongly deduped.
    for (const key of [...this.listening]) {
      if (key.startsWith(`${id}\u0000`)) this.listening.delete(key);
    }
  }

  setText(id: string, text: string): void {
    this.el(id).textContent = text;
  }

  setClass(id: string, cls: string): void {
    this.el(id).className = cls;
  }

  setAttr(id: string, name: string, value: string): void {
    this.el(id).setAttribute(name, value);
  }

  removeAttr(id: string, name: string): void {
    this.el(id).removeAttribute(name);
  }

  setProp(id: string, name: string, value: unknown): void {
    (this.el(id) as unknown as Record<string, unknown>)[name] = value;
  }

  getProp(id: string, name: string): unknown {
    return (this.el(id) as unknown as Record<string, unknown>)[name];
  }

  focus(id: string): void {
    this.el(id).focus();
  }

  listen(id: string, event: string): void {
    const key = `${id}\u0000${event}`;
    if (this.listening.has(key)) return;
    this.listening.add(key);
    this.el(id).addEventListener(event, (ev: Event) => {
      // A form submit (Enter in a single-line input, or the Send button)
      // would otherwise navigate the page; stop it so the presenter owns
      // the submission.
      if (event === "submit") ev.preventDefault();
      const target = ev.currentTarget as unknown as { value?: unknown };
      this.queue.push({ id, event, value: String(target?.value ?? "") });
    });
  }

  drainEvents(): DomEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
