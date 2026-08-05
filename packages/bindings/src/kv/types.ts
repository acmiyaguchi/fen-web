// host.kv: a minimal async string-keyed/string-valued KV surface used as
// the virtual-FS substrate (see README's fen-web architecture table). No
// filesystem semantics live here (paths, directories, etc.) — that policy
// stays in Fennel; this is just get/put/delete/list over a flat
// key/value space.
//
// Bridging seam: like host.fetch, this is promise-based on the JS side.
// wasmoon cannot await a JS promise from inside a Lua coroutine directly;
// the runtime package owns resuming the coroutine when a kv operation's
// promise settles. Because KV operations are fast and don't stream, the
// simplest bridge is not a start/poll pair (unlike fetch) but a single
// "blocking-style" resume: the runtime can drive a kv_start/kv_poll pair
// with the same shape as FetchPoller, OR (simpler, and sufficient given
// no streaming/backpressure concerns) synchronously resume the coroutine
// once the promise settles, since a poll loop only matters for
// long-running/streamed work. This package deliberately does not decide
// which — it exposes the promise-based HostKv interface below and leaves
// the coroutine bridge (including a poll wrapper, if the runtime prefers
// symmetry with fetch) to packages/runtime.

export interface HostKv {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** List all keys with the given prefix, in ascending lexicographic
   * order. Empty prefix lists all keys. */
  list(prefix: string): Promise<string[]>;
}
