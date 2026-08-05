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
  headers?: Record<string, string>;
  /** Pre-encoded request body, if any. */
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
  /** Streaming sink. Called with each chunk of the response body as a
   * Lua-compatible byte string (see toLuaBytes for why). Optional — when
   * omitted, only the accumulated body is returned. */
  onChunk?: (bytes: string) => void;
  /** Mirrors fen's :accumulate-body? (default true). When false, the
   * transport still streams every chunk through onChunk but only retains
   * a bounded head (ACCUMULATE_BODY_CAP bytes) of the body for error
   * diagnostics, instead of buffering the full response — matching the
   * native libcurl backend's FEN_ERROR_BODY_CAP contract
   * (fen/packages/util/vendor/fen_http.c). Policy (whether to set this)
   * stays in Fennel; this flag just tells the TS transport how much to
   * hold in memory. */
  accumulateBody?: boolean;
}

/** Bound on retained body bytes when accumulateBody is false — mirrors
 * FEN_ERROR_BODY_CAP in fen's native C backend. */
export const ACCUMULATE_BODY_CAP = 65536;

export interface FetchSuccess {
  status: number;
  headers: Record<string, string>;
  /** Full accumulated body. Present unless the caller only wanted the
   * streamed chunks (the TS layer always accumulates; policy about
   * whether to keep it lives in Fennel, matching accumulate-body?). */
  body?: string;
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
 * promise settles or when onChunk fires — this package only provides the
 * transport. */
export interface HostFetch {
  fetch(opts: FetchRequestOptions): Promise<FetchResult>;
}
