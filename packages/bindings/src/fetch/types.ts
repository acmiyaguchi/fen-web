// Shared shapes for the host.fetch primitive. These mirror the opts/result
// tables fen's Fennel HTTP layer already uses (see
// fen/packages/util/src/fen/util/http/init.fnl) so the Lua-facing bridge in
// packages/runtime can pass values through with minimal translation
// (camelCase here, kebab-case in Fennel — the runtime package owns that
// translation, same as backends/native.fnl does for the C module).

/** Options for a single HTTP request. */
export interface FetchRequestOptions {
  method: string;
  url: string;
  /** HTTP header names and values must be ASCII; the transports reject
   * non-ASCII entries instead of applying the Lua byte-string conversion. */
  headers?: Record<string, string>;
  /** Request body text after wasmoon has UTF-8-transcoded the Lua string to
   * JS. The transport encodes it as UTF-8 before passing it to fetch(). */
  body?: string;
  /** Overall request timeout. */
  timeoutMs?: number;
  /** Time allowed to establish the connection (best-effort; the browser
   * fetch API does not expose a separate connect phase, so this is folded
   * into the overall AbortController deadline when idleTimeoutMs is not
   * more restrictive). */
  connectTimeoutMs?: number;
  /** Abort if no new bytes arrive for this many ms. 0/undefined disables
   * the idle watchdog. */
  idleTimeoutMs?: number;
  /** Streaming sink. Called with each response chunk as UTF-8 text. The
   * transport keeps a streaming decoder across wire chunks, so a chunk may
   * be empty while it carries only a prefix of a multi-byte character. The
   * resulting JS string crosses wasmoon as ordinary text and is re-encoded
   * to the original UTF-8 bytes in Lua. Optional — when omitted, only the
   * accumulated body is returned. A promise may be returned to apply
   * backpressure to a poll-based consumer. Binary response data is not
   * supported by this string path. */
  onChunk?: (text: string) => void | PromiseLike<void>;
  /** Mirrors fen's :accumulate-body? (default true). When false, the
   * transport still streams every chunk through onChunk but only retains
   * a bounded head (ACCUMULATE_BODY_CAP bytes) of the body for error
   * diagnostics, instead of buffering the full response — matching the
   * native libcurl backend's FEN_ERROR_BODY_CAP contract
   * (fen/packages/util/vendor/fen_http.c). Policy (whether to set this)
   * stays in Fennel; this flag just tells the TS transport how much to
   * hold in memory. */
  accumulateBody?: boolean;
  /** Optional host-side cancellation registration. FetchPoller supplies this
   * callback without changing HostFetch.fetch's method shape; transports that
   * own an AbortController (or an equivalent cancellation primitive) register
   * it here. Hosts that do not support mid-request abort may ignore it. */
  registerAbort?: (abort: () => void) => void;
}

/** Bound on retained body bytes when accumulateBody is false — mirrors
 * FEN_ERROR_BODY_CAP in fen's native C backend. */
export const ACCUMULATE_BODY_CAP = 65536;

export interface FetchSuccess {
  status: number;
  headers: Record<string, string>;
  /** Full body when accumulateBody is true, or a bounded diagnostic head
   * when it is false. The transport owns this copy; the Fennel poll loop
   * forwards it instead of rebuilding it from streamed chunks. */
  body: string;
}

export interface FetchFailure {
  error: string;
}

export type FetchResult = FetchSuccess | FetchFailure;

export function isFetchFailure(r: FetchResult): r is FetchFailure {
  return (r as FetchFailure).error !== undefined;
}

/** The host.fetch primitive: promise-based on the JS side. The runtime
 * package (wasmoon bridge) owns resuming the Lua coroutine when this
 * promise settles; onChunk is a transport sink and may be awaited for
 * poll-queue backpressure. This package never resumes Lua directly. */
export interface HostFetch {
  fetch(opts: FetchRequestOptions): Promise<FetchResult>;
}
