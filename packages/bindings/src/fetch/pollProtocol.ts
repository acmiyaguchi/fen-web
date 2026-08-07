import { utf8ByteLength } from "./bytes.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import type { FetchRequestOptions, FetchResult, HostFetch } from "./types.js";

// Poll protocol used by the Fennel fetch backend
// (fnl/fen/util/http/backends/fetch.fnl). Lua coroutines cannot be
// resumed from inside a JS callback invoked mid-C-call (the "yield across
// a C-call boundary" hazard for wasmoon/Lua 5.4), so the Fennel side
// cannot simply pass onChunk/completion callbacks that call back into
// Lua. Instead the Fennel backend starts a request and polls it in a
// loop, calling opts.yield between polls:
//
//   (let [id (__fen_host.fetch_start opts)]
//     (var result nil)
//     (while (not result)
//       (let [poll (__fen_host.fetch_poll id)]
//         (each [_ chunk (ipairs poll.chunks)] (opts.on-chunk chunk))
//         (if poll.done
//             (do
//               (set result (if poll.error {:error poll.error}
//                               {:status poll.status :headers poll.headers :body poll.body}))
//               (__fen_host.fetch_dispose id))
//             (opts.yield))))
//     result)
//
// This module implements the JS side of that protocol: fetchStart kicks
// off the underlying promise-based HostFetch and buffers a bounded pending
// batch of chunks as they arrive; fetchPoll drains the batch and reports
// terminal state only after every chunk has crossed the poll boundary. When
// the batch is full, the transport awaits space created by the next poll.
// fetchDispose drops the state and unblocks a producer that is parked on
// backpressure; fetchAbort marks a live state cancelled and invokes its
// transport abort hook without deleting it. The runtime package wires
// __fen_host.fetch_start / __fen_host.fetch_poll / __fen_host.fetch_abort /
// __fen_host.fetch_dispose to a shared FetchPoller instance.

export interface FetchPollResult {
  /** Chunks received since the last poll, in order, already drained. */
  chunks: string[];
  /** True once the request has completed (success or error) and no chunks remain buffered. */
  done: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** Error delivered to a HostFetch producer when its poll request is abandoned. */
export class FetchPollerDisposedError extends Error {
  readonly code = "FETCH_POLLER_DISPOSED";

  constructor() {
    super("FetchPoller: request was disposed");
    this.name = "FetchPollerDisposedError";
  }
}

/** Error raised synchronously when a host ignores a backpressure promise and
 * calls onChunk again. Ignoring the promise would otherwise lose chunks once
 * the poller reaches its bounded handoff queue. */
export class FetchPollerBackpressureError extends Error {
  readonly code = "FETCH_POLLER_BACKPRESSURE";

  constructor() {
    super("FetchPoller: HostFetch must await onChunk backpressure before delivering another chunk");
    this.name = "FetchPollerBackpressureError";
  }
}

interface WaitingChunk {
  bytes: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface PollState {
  chunks: string[];
  /** Number of UTF-8 bytes currently retained in chunks. */
  pendingBytes: number;
  /** At most one chunk is held back until poll() drains the current batch. */
  waitingChunks: WaitingChunk[];
  disposed: boolean;
  done: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  /** Transport-side abort hook, installed by a HostFetch that supports it. */
  abortUnderlying?: () => void;
  /** True after FetchPoller.abort marks the request terminal. */
  cancelled?: boolean;
}

// A poll is the only point at which the Fennel coroutine can consume data.
// Keep the JS-side handoff queue bounded as well: without this, a fast fetch
// can finish before the next poll and retain the whole streamed body in
// state.chunks even when accumulateBody is false. One oversized transport
// chunk is allowed, since a chunk cannot be split without changing the
// streaming contract. Response chunks are UTF-8 text; binary data is not
// supported by this string path.
export const MAX_PENDING_BYTES = ACCUMULATE_BODY_CAP;
export const MAX_PENDING_CHUNKS = 128;

let nextId = 1;

/** Bridges a promise-based HostFetch to the start/poll protocol consumed
 * by the Fennel backend. One instance is shared across all requests; each
 * fetchStart call gets its own numeric id. */
export class FetchPoller {
  private requests = new Map<number, PollState>();

  constructor(private readonly host: HostFetch) {}

  /** Begin a request; returns an id to pass to poll(). Does not block. */
  start(opts: FetchRequestOptions): number {
    const id = nextId++;
    const state: PollState = {
      chunks: [],
      pendingBytes: 0,
      waitingChunks: [],
      disposed: false,
      done: false,
    };
    this.requests.set(id, state);

    let fetchPromise: Promise<FetchResult>;
    try {
      // Promise.resolve also keeps a non-conforming synchronous host from
      // escaping start() without transitioning this request to an error.
      fetchPromise = Promise.resolve(
        // `registerAbort` is an optional extension of the request options,
        // not a change to HostFetch.fetch, so hosts without an abort seam
        // remain valid and still receive the poller's terminal cancellation
        // state.
        this.host.fetch({
          ...opts,
          registerAbort: (abort) => {
            state.abortUnderlying = abort;
          },
          onChunk: (bytes) => this.enqueue(state, bytes),
        }),
      );
    } catch (err) {
      fetchPromise = Promise.reject<FetchResult>(err);
    }

    fetchPromise
      .then((result) => {
        if (state.disposed || state.cancelled) return;
        if (this.isFetchFailure(result)) {
          state.error = result.error;
        } else {
          state.status = result.status;
          state.headers = result.headers;
          state.body = result.body;
        }
        // A non-cooperating host can return while its last onChunk promise is
        // still parked. Keep done withheld until poll() releases that chunk;
        // otherwise fetch.fnl would dispose the request and discard it.
        state.done = true;
      })
      .catch((err) => {
        if (state.disposed || state.cancelled) return;
        state.error = err instanceof Error ? err.message : String(err);
        state.done = true;
      });

    return id;
  }

  /** Enqueue a chunk, waiting for the next poll when the handoff queue is
   * full. The returned promise is awaited by the transport, never by Lua or
   * a JS callback that calls into Lua, so the coroutine bridge remains
   * poll-driven. A second call while that promise is outstanding is a host
   * protocol violation and throws synchronously instead of silently parking
   * an unbounded list of chunks. */
  private enqueue(state: PollState, bytes: string): void | Promise<void> {
    if (state.disposed) throw new FetchPollerDisposedError();
    if (state.waitingChunks.length > 0) throw new FetchPollerBackpressureError();

    if (this.hasCapacity(state, bytes)) {
      state.chunks.push(bytes);
      state.pendingBytes += utf8ByteLength(bytes);
      return;
    }

    let resolveWaiting!: () => void;
    let rejectWaiting!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiting = resolve;
      rejectWaiting = reject;
    });
    // A host is allowed by the public type to ignore a returned promise. If
    // dispose() rejects such a promise, this handler prevents an unhandled
    // rejection while preserving the rejection for an awaiting host.
    promise.catch(() => undefined);
    state.waitingChunks.push({ bytes, resolve: resolveWaiting, reject: rejectWaiting });
    return promise;
  }

  private isFetchFailure(result: FetchResult): result is { error: string } {
    return (
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof (result as { error: unknown }).error === "string"
    );
  }

  private hasCapacity(state: PollState, text: string): boolean {
    // Permit one oversized chunk when the queue is empty; preserving a whole
    // chunk is required for ordered streaming and avoids silently truncating
    // UTF-8 text.
    return (
      state.chunks.length === 0 ||
      (state.chunks.length < MAX_PENDING_CHUNKS &&
        state.pendingBytes + utf8ByteLength(text) <= MAX_PENDING_BYTES)
    );
  }

  private releaseWaiting(state: PollState): void {
    while (state.waitingChunks.length > 0) {
      const next = state.waitingChunks[0];
      if (!this.hasCapacity(state, next.bytes)) return;
      state.waitingChunks.shift();
      state.chunks.push(next.bytes);
      state.pendingBytes += utf8ByteLength(next.bytes);
      next.resolve();
    }
  }

  /** Drain buffered chunks and report terminal state, if any. Safe to
   * call repeatedly after done — returns done:true with an empty chunk
   * list on subsequent polls. A chunk released from waitingChunks is held
   * for the next poll, so terminal state can never race ahead of it. */
  poll(id: number): FetchPollResult {
    const state = this.requests.get(id);
    if (!state) {
      throw new Error(`FetchPoller: unknown request id ${id}`);
    }
    const chunks = state.chunks;
    state.chunks = [];
    state.pendingBytes = 0;
    this.releaseWaiting(state);
    return {
      chunks,
      done: state.done && state.waitingChunks.length === 0 && state.chunks.length === 0,
      status: state.status,
      headers: state.headers,
      body: state.body,
      error: state.error,
    };
  }

  /** Abort a live request without dropping its poll state. The next poll
   * observes `{error: "cancelled"}` and the Fennel terminal branch then calls
   * dispose(), while the transport's AbortController is cancelled immediately
   * rather than waiting for another poll boundary. */
  abort(id: number): void {
    const state = this.requests.get(id);
    if (!state || state.disposed || state.cancelled) return;
    state.cancelled = true;
    state.error = "cancelled";
    state.done = true;
    try {
      state.abortUnderlying?.();
    } catch {
      // Cancellation is best effort at the transport seam; the terminal poll
      // state still guarantees that the Lua loop can unwind and dispose it.
    }
    const cancellation = new Error("FetchPoller: request was aborted");
    for (const waiting of state.waitingChunks.splice(0)) waiting.reject(cancellation);
  }

  /** Abort every live request, retaining their terminal state until the Lua
   * poll loop disposes them. Used by the user cancel path. */
  abortAll(): void {
    for (const id of [...this.requests.keys()]) this.abort(id);
  }

  /** Drop state for a request and cancel its underlying transport and any
   * producer parked on backpressure. fetch.fnl calls this in its terminal
   * branch; callers abandoning a VM should prefer disposeAll() so an
   * in-flight stream cannot retain a reader or response body after the VM is
   * closed. */
  dispose(id: number): void {
    const state = this.requests.get(id);
    if (!state) return;
    state.disposed = true;
    this.requests.delete(id);
    const wasParked = state.waitingChunks.length > 0;
    const cancellation = new FetchPollerDisposedError();
    for (const waiting of state.waitingChunks.splice(0)) {
      waiting.reject(cancellation);
    }
    // Rejecting a parked onChunk promise is enough to unwind a reader that is
    // currently applying poller backpressure, and preserves the distinguishable
    // disposed result for hosts that report that rejection. When no producer
    // is parked, abort the underlying read/connection immediately. A completed
    // request has already released its transport; calling its registration
    // after normal fetch_dispose would report a false abort.
    if (!state.done && !wasParked) {
      try {
        state.abortUnderlying?.();
      } catch {
        // Resource teardown is best effort; the state is already abandoned.
      }
    }
    // The host callback closes over state until its promise settles. Clear
    // all retained body data now rather than waiting for that continuation.
    state.chunks = [];
    state.pendingBytes = 0;
    state.body = undefined;
    state.headers = undefined;
    state.error = undefined;
  }

  /** Abandon every outstanding request, including producers parked on a
   * backpressure promise. This is the VM-teardown cleanup seam. */
  disposeAll(): void {
    for (const id of [...this.requests.keys()]) this.dispose(id);
  }
}
