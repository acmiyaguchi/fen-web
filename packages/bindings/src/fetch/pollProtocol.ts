import type { FetchRequestOptions, HostFetch } from "./types.js";

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
// off the underlying promise-based HostFetch and buffers chunks as they
// arrive; fetchPoll drains the buffer and reports terminal state once the
// promise settles; fetchDispose drops the terminal state so a long-lived
// VM doesn't accumulate one entry per request forever. The runtime
// package wires __fen_host.fetch_start / __fen_host.fetch_poll /
// __fen_host.fetch_dispose to a shared FetchPoller instance's start /
// poll / dispose methods (in that order — dispose is mandatory cleanup,
// not optional, once fetch.fnl's terminal branch calls it on every
// completed request).

export interface FetchPollResult {
  /** Chunks received since the last poll, in order, already drained. */
  chunks: string[];
  /** True once the request has completed (success or error). */
  done: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

interface PollState {
  chunks: string[];
  done: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

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
    const state: PollState = { chunks: [], done: false };
    this.requests.set(id, state);

    this.host
      .fetch({
        ...opts,
        onChunk: (bytes) => {
          state.chunks.push(bytes);
        },
      })
      .then((result) => {
        if ("error" in result) {
          state.error = result.error;
        } else {
          state.status = result.status;
          state.headers = result.headers;
          state.body = result.body;
        }
        state.done = true;
      })
      .catch((err) => {
        state.error = err instanceof Error ? err.message : String(err);
        state.done = true;
      });

    return id;
  }

  /** Drain buffered chunks and report terminal state, if any. Safe to
   * call repeatedly after done — returns done:true with an empty chunk
   * list on subsequent polls. */
  poll(id: number): FetchPollResult {
    const state = this.requests.get(id);
    if (!state) {
      throw new Error(`FetchPoller: unknown request id ${id}`);
    }
    const chunks = state.chunks;
    state.chunks = [];
    return {
      chunks,
      done: state.done,
      status: state.status,
      headers: state.headers,
      body: state.body,
      error: state.error,
    };
  }

  /** Drop terminal state for a completed request (wired to
   * __fen_host.fetch_dispose). fetch.fnl calls this in its terminal
   * branch on every completed request; without it `requests` grows by
   * one entry per HTTP call for the life of the VM. */
  dispose(id: number): void {
    this.requests.delete(id);
  }
}
