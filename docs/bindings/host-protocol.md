# Host protocol (`__fen_host`)

The Fennel side of every binding talks to JS through a single global,
`_G.__fen_host`, installed by `packages/runtime` before Fennel bootstrap.
Each primitive is a set of functions hung off that table
(`fetch_start`/`fetch_poll`, `kv` methods, ...).

## Why poll, not callback

wasmoon runs the agent inside a Lua coroutine. Lua 5.4 cannot yield across
a C-call boundary: a JS callback invoked from inside a pending
`host.fetch` promise that tried to resume the coroutine would attempt
exactly that. So the JS side never calls back into Lua. Instead, for
operations that can be long-running (fetch and preview RPCs), the pattern
is start/poll:

```fennel
(let [id (__fen_host.fetch_start opts)]
  (var result nil)
  (while (not result)
    (let [poll (__fen_host.fetch_poll id)]
      (each [_ chunk (ipairs poll.chunks)] (opts.on-chunk chunk))
      (if poll.done
          (do
            (set result (if poll.error {:error poll.error}
                            {:status poll.status :headers poll.headers :body poll.body}))
            (__fen_host.fetch_dispose id))
          (opts.yield))))
  result)
```

`fetch_start` kicks off a promise-based fetch and returns an id
immediately (non-blocking). `fetch_poll` drains buffered chunks and
reports terminal state once the promise settles AND every buffered chunk
(including any producer parked on backpressure) has been drained — `done`
is withheld while chunks remain, so a poll loop that exits on `done` can
never strand data. Between polls, the
Fennel loop calls `opts.yield` (`coroutine.yield`) so the VM cooperates
instead of busy-looping a single Lua call — the backend requires
`opts.yield` and errors if it's absent (no blocking-mode fallback; see
[fetch.md](fetch.md)). `fetch_dispose` is called on every terminal branch,
not optionally. JS resumes nothing; Lua always drives. Source:
`packages/bindings/src/fetch/pollProtocol.ts`,
`packages/bindings/fnl/fen/util/http/backends/fetch.fnl`.

`host.kv` operations are fast and don't stream, so they don't need the
poll shape — see [kv.md](kv.md) for how that bridge differs. The `HostKv`
interface deliberately leaves the coroutine-resume mechanism to
`packages/runtime` rather than deciding it in `packages/bindings`
(`packages/bindings/src/kv/types.ts:7-19`).

## fetch_dispose (wired, mandatory)

`__fen_host.fetch_dispose(id)` drops the JS-side terminal state for a
completed request (`FetchPoller.dispose` in
`packages/bindings/src/fetch/pollProtocol.ts`). `fetch.fnl`'s `request`
calls it on every terminal branch of the poll loop — not optional cleanup:
without it, `FetchPoller`'s internal map grows by one entry per HTTP call
for the life of the VM, since request ids are never reused. The runtime
package wires `fetch_start`/`fetch_poll`/`fetch_dispose` to a shared
`FetchPoller` instance's `start`/`poll`/`dispose` methods, in that order.

`dispose` (and the poller-level `disposeAll()`, the VM-teardown seam
called before `rt.close()`) also releases any producer parked on a
backpressure promise by rejecting it with `FetchPollerDisposedError`
(`code: "FETCH_POLLER_DISPOSED"`), so the host's `finally` runs and the
underlying reader/connection is cancelled rather than leaked.

## Byte and latin1 discipline

wasmoon marshals JS strings into Lua strings via UTF-16/UTF-8-ish
coercion, but Lua strings are plain byte arrays and HTTP bodies (SSE
frames, JSON, occasionally binary) are not guaranteed valid UTF-8
mid-stream — a chunk boundary can split a multi-byte sequence. Decoding as
UTF-8 text would corrupt or throw.

The bridge instead uses a latin1 (ISO-8859-1) 1:1 byte mapping: byte value
N maps to JS code unit N, lossless for any byte 0-255. `toLuaBytes` /
`fromLuaBytes` in `packages/bindings/src/fetch/bytes.ts` implement this
(Node `Buffer` `'latin1'` encoding where available, chunked
`String.fromCharCode` fallback otherwise). Every chunk crossing the
JS/Lua boundary goes through this conversion — never `TextDecoder`/UTF-8.

See also: [fetch.md](fetch.md), [kv.md](kv.md),
[../architecture/seams.md](../architecture/seams.md).

The same rule applies to the preview console: the iframe harness posts
records to JS, the host buffers them, and Lua reads them synchronously with
`preview_console_drain` when the tool is called. **Its return value is JSON
text, never a JS aggregate/array.** This is a hard wasmoon boundary invariant:
JS arrays cross into Lua as proxy userdata and must not be handed to cjson. The
serialized text is capped at 65,536 characters, keeps newest entries, and ends
with a synthetic warning carrying the count of omitted older entries when the
cap is reached (the ring and per-entry bounds are documented in
[preview.md](preview.md)). JS never invokes Lua from a `message` listener.
