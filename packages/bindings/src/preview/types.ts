// host.preview: the sandboxed-iframe preview primitive (fen-web#8). The
// agent drives the app it just built (rendered from the IndexedDB virtual FS)
// through a postMessage RPC channel — never by reaching into the iframe
// directly. Like host.fetch (and unlike the synchronous host.dom-apply),
// the RPC is asynchronous — a postMessage round trip to another execution
// context — so it uses the same start/poll/dispose bridge fetch does
// (docs/bindings/host-protocol.md): the Fennel preview tools start a call,
// poll for its result, and yield the turn coroutine between polls rather
// than passing a callback that would resume Lua across a C-call boundary.
//
// SECURITY INVARIANT (docs/apps/web.md, docs/bindings/preview.md): the
// preview iframe runs with `sandbox="allow-scripts"` and NO
// `allow-same-origin`. User-generated JS in the iframe therefore runs in an
// opaque origin and cannot reach the parent frame's virtual FS, the API key
// (env/apikey/<VAR> in IndexedDB), or any forge token. The only channel is
// this RPC surface, and it carries only command arguments (selectors,
// values, expressions) — never any secret — outbound, and validates that
// inbound messages originate from THIS iframe's window before trusting them.

/** The RPC verbs the preview responder understands, one per preview.* tool. */
export type PreviewRpcMethod =
  | "query"
  | "click"
  | "fill"
  | "eval"
  | "screenshot"
  | "dom"
  | "interact";

export type PreviewConsoleLevel = "log" | "warn" | "error" | "info" | "debug";

/** One bounded, already-stringified entry from the preview iframe. */
export interface PreviewConsoleEntry {
  level: PreviewConsoleLevel;
  args: string[];
  /** Present for Error objects and uncaught errors/rejections. */
  stack?: string;
  /** True for window.onerror and unhandledrejection entries. */
  uncaught?: boolean;
}

/** A single RPC request posted into the preview iframe. Only the fields a
 * given method needs are populated; none ever carry secrets. */
export interface PreviewRpcRequest {
  method: PreviewRpcMethod;
  /** query/click/fill/screenshot: a CSS selector. */
  selector?: string;
  /** fill: the value to set on the matched element. */
  value?: string;
  /** interact: the action to perform on the matched element. */
  action?: "click" | "type" | "submit";
  /** interact/type: text to place in the matched field. */
  text?: string;
  /** dom: maximum descendant depth to include in the serialized snapshot. */
  maxDepth?: number;
  /** dom: maximum serialized character count. */
  maxSize?: number;
  /** eval: the JavaScript expression to evaluate in the iframe. */
  expr?: string;
}

/** The result of one RPC, produced inside the iframe by the responder and
 * relayed back to the parent. Structured (named fields), never a bare value,
 * so callers branch on `ok` rather than sniffing shapes. */
export interface PreviewRpcResult {
  ok: boolean;
  /** Method-specific payload on success (query info, dataUrl, eval value…). */
  value?: unknown;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/** One poll of an in-flight RPC. `done` flips true once the responder has
 * replied (mirrors FetchPollResult.done). */
export interface PreviewPollResult {
  done: boolean;
  result?: PreviewRpcResult;
}

/** The host.preview primitive. `setHtml` re-renders the preview document
 * (preview.refresh); the rpc* trio is the async postMessage bridge the
 * preview.dom/interact and legacy query/click/fill/eval/screenshot tools drive;
 * `preview_console` drains the host-side console ring. */
export interface HostPreview {
  /** Render `html` into the sandboxed iframe (creating the iframe on first use). */
  setHtml(html: string): void;
  /** Begin an RPC; returns an id to pass to rpcPoll/rpcDispose. Non-blocking. */
  rpcStart(req: PreviewRpcRequest): number;
  /** Report whether the RPC has completed, and its result once it has. */
  rpcPoll(id: number): PreviewPollResult;
  /** Drop terminal state for a completed RPC (mandatory cleanup, like
   * FetchPoller.dispose). */
  rpcDispose(id: number): void;
  /** Drain entries not returned by an earlier drain or reset by setHtml. */
  drainConsole(): PreviewConsoleEntry[];
  /** Count unread uncaught errors without draining them. */
  uncaughtConsoleErrors(): number;
  /** Return the bounded recent tail without changing drain state. */
  previewConsoleTail(): readonly PreviewConsoleEntry[];
  /** Release the iframe and window listener owned by this boot. */
  dispose(): void;
}
