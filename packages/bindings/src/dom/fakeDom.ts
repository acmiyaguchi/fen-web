import type { DomAdapter } from "./applyOps.js";
import { applyDomOps } from "./applyOps.js";
import type { DomOp, DomEvent, DomResult, HostDomApply } from "./types.js";

/** A single node in the fake tree. */
export interface FakeNode {
  tag: string;
  id: string;
  parent: string | null;
  children: string[];
  text: string;
  className: string;
  attrs: Map<string, string>;
  props: Map<string, unknown>;
  listeners: Set<string>;
  focused: boolean;
}

/** In-memory DOM stand-in implementing DomAdapter, for Node/Busted tests
 * that exercise the op semantics without a browser. Mirrors WebHostDomApply
 * against a plain tree, the way MemoryKv mirrors IndexedDbKv. A pre-created
 * root node lets a batch's first `create` attach somewhere real. */
export class FakeDom implements DomAdapter, HostDomApply {
  private nodes = new Map<string, FakeNode>();
  private queue: DomEvent[] = [];

  constructor(rootId = "fen-app") {
    this.nodes.set(rootId, this.blankNode("div", rootId, null));
  }

  private blankNode(tag: string, id: string, parent: string | null): FakeNode {
    return {
      tag,
      id,
      parent,
      children: [],
      text: "",
      className: "",
      attrs: new Map(),
      props: new Map(),
      listeners: new Set(),
      focused: false,
    };
  }

  private node(id: string): FakeNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`FakeDom: no element '${id}'`);
    return n;
  }

  apply(ops: DomOp[]): DomResult[] {
    return applyDomOps(this, ops);
  }

  // --- DomAdapter ---

  exists(id: string): boolean {
    return this.nodes.has(id);
  }

  create(tag: string, id: string, parentId: string, beforeId?: string): void {
    const parent = this.node(parentId);
    const node = this.blankNode(tag, id, parentId);
    this.nodes.set(id, node);
    if (beforeId) {
      const idx = parent.children.indexOf(beforeId);
      if (idx < 0) throw new Error(`FakeDom: before-sibling '${beforeId}' not under '${parentId}'`);
      parent.children.splice(idx, 0, id);
    } else {
      parent.children.push(id);
    }
  }

  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.parent) {
      const siblings = this.node(node.parent).children;
      const idx = siblings.indexOf(id);
      if (idx >= 0) siblings.splice(idx, 1);
    }
    for (const child of [...node.children]) this.remove(child);
    this.nodes.delete(id);
  }

  setText(id: string, text: string): void {
    this.node(id).text = text;
  }

  setClass(id: string, cls: string): void {
    this.node(id).className = cls;
  }

  setAttr(id: string, name: string, value: string): void {
    this.node(id).attrs.set(name, value);
  }

  removeAttr(id: string, name: string): void {
    this.node(id).attrs.delete(name);
  }

  setProp(id: string, name: string, value: unknown): void {
    this.node(id).props.set(name, value);
  }

  getProp(id: string, name: string): unknown {
    const node = this.node(id);
    if (name === "value") return node.props.get("value") ?? "";
    return node.props.get(name);
  }

  focus(id: string): void {
    for (const n of this.nodes.values()) n.focused = false;
    this.node(id).focused = true;
  }

  listen(id: string, event: string): void {
    this.node(id).listeners.add(event);
  }

  drainEvents(): DomEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  // --- test helpers ---

  /** Simulate a DOM event; only fires if a matching listener was
   * registered, mirroring the web adapter's addEventListener dispatch. */
  emit(id: string, event: string, value = ""): void {
    if (this.node(id).listeners.has(event)) this.queue.push({ id, event, value });
  }

  /** Read a node for assertions (throws if absent). */
  get(id: string): FakeNode {
    return this.node(id);
  }

  /** Ordered child ids of a container, for asserting fragment diffs. */
  childIds(id: string): string[] {
    return [...this.node(id).children];
  }
}
