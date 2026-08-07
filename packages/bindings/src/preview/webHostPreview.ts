import type {
  HostPreview,
  PreviewPollResult,
  PreviewRpcRequest,
} from "./types.js";
import { wrapSrcdoc } from "./responder.js";
import {
  copyPreviewConsoleEntries,
  normalizePreviewConsoleEntry,
  PREVIEW_CONSOLE_MAX_ENTRIES,
} from "./console.js";
import type { PreviewConsoleEntry } from "./types.js";

interface RpcState {
  req: PreviewRpcRequest;
  done: boolean;
  result?: PreviewPollResult["result"];
}

/** Minimal structural views of the DOM/window pieces WebHostPreview touches,
 * so it can be driven by a fake document/window in Node tests (there is no
 * jsdom in this repo) as well as the real browser globals. */
interface PreviewIframe {
  setAttribute(name: string, value: string): void;
  addEventListener(type: "load", listener: () => void): void;
  remove(): void;
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}
interface PreviewDocument {
  createElement(tag: "iframe"): PreviewIframe;
  getElementById(id: string): { appendChild(node: PreviewIframe): void } | null;
  body: { appendChild(node: PreviewIframe): void };
}
interface PreviewWindow {
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown; source: unknown; origin?: string }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (ev: { data: unknown; source: unknown; origin?: string }) => void,
  ): void;
}

export interface WebHostPreviewOptions {
  document?: PreviewDocument;
  window?: PreviewWindow;
  /** Id of the page element the iframe mounts under; falls back to <body>. */
  mountId?: string;
  /** Maximum number of preview-console entries retained by this host. */
  consoleLimit?: number;
}

/**
 * Real-DOM implementation of host.preview. Owns one sandboxed iframe and the
 * postMessage RPC bridge into it.
 *
 * SECURITY INVARIANT (docs/bindings/preview.md): the iframe is created with
 * `sandbox="allow-scripts"` and never `allow-same-origin`, so its scripts run
 * in an opaque origin with no reach into the parent's DOM/FS/key. Inbound
 * messages are trusted only when `event.source === iframe.contentWindow`
 * (unforgeable window identity) — origin is not usable as an allowlist key
 * because a sandboxed frame reports origin `"null"`. Outbound messages carry
 * only RPC command arguments, never secrets.
 */
export class WebHostPreview implements HostPreview {
  private iframe: PreviewIframe | null = null;
  private ready = false;
  private listenerBound = false;
  private readonly pending: number[] = [];
  private readonly requests = new Map<number, RpcState>();
  private readonly consoleEntries: Array<{ sequence: number; entry: PreviewConsoleEntry }> = [];
  private readonly consoleLimit: number;
  private nextConsoleSequence = 0;
  private consoleDrainSequence = 0;
  private documentGeneration = 0;
  private nextId = 1;
  private readonly messageListener = (ev: {
    data: unknown;
    source: unknown;
    origin?: string;
  }) => this.onMessage(ev);

  constructor(private readonly opts: WebHostPreviewOptions = {}) {
    const requested = Math.floor(opts.consoleLimit ?? PREVIEW_CONSOLE_MAX_ENTRIES);
    this.consoleLimit = Number.isFinite(requested)
      ? Math.max(1, requested)
      : PREVIEW_CONSOLE_MAX_ENTRIES;
  }

  private get document(): PreviewDocument {
    return this.opts.document ?? (globalThis.document as unknown as PreviewDocument);
  }
  private get window(): PreviewWindow {
    return this.opts.window ?? (globalThis.window as unknown as PreviewWindow);
  }
  private get mountId(): string {
    return this.opts.mountId ?? "fen-preview";
  }

  setHtml(html: string): void {
    const iframe = this.ensureIframe();
    // A fresh document is loading; hold RPCs until its responder handshakes.
    // Console entries belong to one rendered app, so a refresh starts a new
    // unread window and does not report failures from the old document.
    this.ready = false;
    this.documentGeneration += 1;
    this.consoleEntries.length = 0;
    this.consoleDrainSequence = this.nextConsoleSequence;
    iframe.setAttribute("srcdoc", wrapSrcdoc(html, this.documentGeneration));
  }

  rpcStart(req: PreviewRpcRequest): number {
    const id = this.nextId++;
    this.requests.set(id, { req, done: false });
    this.ensureIframe();
    if (this.ready) this.post(id, req);
    else this.pending.push(id);
    return id;
  }

  rpcPoll(id: number): PreviewPollResult {
    const state = this.requests.get(id);
    if (!state) throw new Error(`WebHostPreview: unknown rpc id ${id}`);
    return { done: state.done, result: state.result };
  }

  rpcDispose(id: number): void {
    this.requests.delete(id);
  }

  drainConsole(): PreviewConsoleEntry[] {
    const entries = this.consoleEntries
      .filter(({ sequence }) => sequence > this.consoleDrainSequence)
      .map(({ entry }) => entry);
    this.consoleDrainSequence = this.nextConsoleSequence;
    return copyPreviewConsoleEntries(entries);
  }

  uncaughtConsoleErrors(): number {
    return this.consoleEntries.filter(
      ({ sequence, entry }) => sequence > this.consoleDrainSequence && entry.uncaught === true,
    ).length;
  }

  previewConsoleTail(): readonly PreviewConsoleEntry[] {
    return copyPreviewConsoleEntries(this.consoleEntries.map(({ entry }) => entry));
  }

  /** Test/integration seam for a console message received from the iframe. */
  recordConsole(entry: unknown): void {
    const normalized = normalizePreviewConsoleEntry(entry);
    if (!normalized) return;
    this.nextConsoleSequence += 1;
    this.consoleEntries.push({ sequence: this.nextConsoleSequence, entry: normalized });
    if (this.consoleEntries.length > this.consoleLimit) {
      this.consoleEntries.splice(0, this.consoleEntries.length - this.consoleLimit);
    }
  }

  dispose(): void {
    if (this.listenerBound) {
      this.window.removeEventListener("message", this.messageListener);
      this.listenerBound = false;
    }
    this.iframe?.remove();
    this.iframe = null;
    this.ready = false;
    this.pending.length = 0;
    this.requests.clear();
    // Keep the bounded tail available to DiagnosticsBuffer after a fatal
    // closes the VM/iframe. A later setHtml starts a fresh document and
    // clears it, so this does not leak across preview refreshes.
  }

  private ensureIframe(): PreviewIframe {
    if (this.iframe) return this.iframe;
    const doc = this.document;
    const iframe = doc.createElement("iframe");
    // SECURITY: allow-scripts ONLY. Never add allow-same-origin — that would
    // grant iframe JS the parent origin (virtual FS, API key, forge token).
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("id", `${this.mountId}-frame`);
    iframe.setAttribute("title", "fen-web preview");
    iframe.addEventListener("load", () => this.onLoad());
    const mount = doc.getElementById(this.mountId) ?? doc.body;
    mount.appendChild(iframe);
    this.iframe = iframe;
    this.bindMessageListener();
    return iframe;
  }

  private bindMessageListener(): void {
    if (this.listenerBound) return;
    this.listenerBound = true;
    this.window.addEventListener("message", this.messageListener);
  }

  private onLoad(): void {
    // The srcdoc responder posts a ready handshake, but treat `load` as
    // ready too so buffered RPCs flush even if that message races the event.
    this.ready = true;
    this.flushPending();
  }

  private onMessage(ev: { data: unknown; source: unknown; origin?: string }): void {
    // SECURITY: trust only messages from THIS iframe's window. A sandboxed
    // (opaque-origin) frame reports origin "null", so origin cannot gate the
    // allowlist; source identity is unforgeable and is the real guard.
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    const data = ev.data as {
      __fenPreview?: boolean;
      ready?: boolean;
      type?: unknown;
      entry?: unknown;
      id?: number;
      result?: PreviewPollResult["result"];
    } | null;
    if (!data || data.__fenPreview !== true) return;
    if (data.ready === true) {
      this.ready = true;
      this.flushPending();
      return;
    }
    if (data.type === "console") {
      const entry = data.entry;
      if (!entry || typeof entry !== "object") return;
      const generation = (entry as Record<string, unknown>).generation;
      // The iframe window is reused across srcdoc navigations. A message that
      // was queued by the old document can therefore arrive after setHtml;
      // source identity alone cannot distinguish it from the new document.
      if (generation !== this.documentGeneration) return;
      this.recordConsole(entry);
      return;
    }
    if (typeof data.id !== "number") return;
    const state = this.requests.get(data.id);
    if (!state) return;
    state.done = true;
    state.result = data.result ?? { ok: false, error: "empty preview result" };
  }

  private flushPending(): void {
    if (!this.ready) return;
    const ids = this.pending.splice(0, this.pending.length);
    for (const id of ids) {
      const state = this.requests.get(id);
      if (state) this.post(id, state.req);
    }
  }

  private post(id: number, req: PreviewRpcRequest): void {
    const win = this.iframe?.contentWindow;
    if (!win) return;
    // targetOrigin "*": the sandboxed iframe has an opaque ("null") origin,
    // which is not a targetable value; the payload is only RPC command args
    // (selector/value/expr) — never a secret — so "*" is safe here.
    win.postMessage(
      {
        __fenPreview: true,
        id,
        method: req.method,
        selector: req.selector,
        value: req.value,
        expr: req.expr,
      },
      "*",
    );
  }
}
