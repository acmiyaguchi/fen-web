import type {
  HostPreview,
  PreviewConsoleEntry,
  PreviewPollResult,
  PreviewRpcRequest,
  PreviewRpcResult,
} from "./types.js";
import {
  copyPreviewConsoleEntries,
  normalizePreviewConsoleEntry,
  PREVIEW_CONSOLE_MAX_ENTRIES,
} from "./console.js";
import { serializePreviewRpcResult } from "./webHostPreview.js";

/** A synchronous, in-memory host.preview double for Node/off-DOM tests (the
 * way ScriptedFetch/FakeDom stand in for their real bindings). It records the
 * last rendered HTML and every RPC request, and resolves each RPC immediately
 * via a caller-supplied responder — so a poll always reports `done: true` on
 * the first call and no cooperative yield is needed. */
export class FakePreview implements HostPreview {
  html: string | null = null;
  readonly requests: PreviewRpcRequest[] = [];
  private readonly results = new Map<number, PreviewRpcResult>();
  private readonly consoleEntries: PreviewConsoleEntry[] = [];
  private readonly consoleLimit: number;
  private consoleDrainIndex = 0;
  private nextId = 1;

  constructor(
    private readonly responder: (req: PreviewRpcRequest) => PreviewRpcResult = () => ({
      ok: true,
    }),
    options: { consoleLimit?: number } = {},
  ) {
    const requested = Math.floor(options.consoleLimit ?? PREVIEW_CONSOLE_MAX_ENTRIES);
    this.consoleLimit = Number.isFinite(requested)
      ? Math.max(1, requested)
      : PREVIEW_CONSOLE_MAX_ENTRIES;
  }

  setHtml(html: string): void {
    this.html = html;
    this.consoleEntries.length = 0;
    this.consoleDrainIndex = 0;
  }

  rpcStart(req: PreviewRpcRequest): number {
    this.requests.push(req);
    const id = this.nextId++;
    this.results.set(id, this.responder(req));
    return id;
  }

  rpcPoll(id: number): PreviewPollResult {
    return { done: true, result: serializePreviewRpcResult(this.results.get(id)) };
  }

  rpcDispose(id: number): void {
    this.results.delete(id);
  }

  drainConsole(): PreviewConsoleEntry[] {
    const entries = this.consoleEntries.slice(this.consoleDrainIndex);
    this.consoleDrainIndex = this.consoleEntries.length;
    return copyPreviewConsoleEntries(entries);
  }

  uncaughtConsoleErrors(): number {
    return this.consoleEntries
      .slice(this.consoleDrainIndex)
      .filter((entry) => entry.uncaught === true).length;
  }

  previewConsoleTail(): readonly PreviewConsoleEntry[] {
    return copyPreviewConsoleEntries(this.consoleEntries);
  }

  /** Add a synthetic iframe entry in tests, matching WebHostPreview's seam. */
  recordConsole(entry: unknown): void {
    const normalized = normalizePreviewConsoleEntry(entry);
    if (!normalized) return;
    this.consoleEntries.push(normalized);
    if (this.consoleEntries.length > this.consoleLimit) {
      const removed = this.consoleEntries.length - this.consoleLimit;
      this.consoleEntries.splice(0, removed);
      this.consoleDrainIndex = Math.max(0, this.consoleDrainIndex - removed);
    }
  }

  dispose(): void {
    this.results.clear();
    // Keep the bounded tail available to diagnostics after a fatal close;
    // setHtml starts a new document and resets it.
  }
}
