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
                            {:status poll.status :headers-json poll.headers-json :body poll.body}))
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
not optionally. JS resumes nothing; Lua always drives.

`fetch_poll` terminal results carry response headers as `headers-json`,
host-owned JSON text serialized by the JS host. This is the same hard
never-let-a-JS-proxy-reach-Lua invariant as `preview_console_drain` (see
[preview.md](preview.md)): wasmoon exposes nested JS objects as proxy userdata,
and `pairs()` on that userdata throws—the mechanism behind issue #65. The
Fennel fetch backend decodes `headers-json` before retry code or tools inspect
it. Pure-Fennel hosts may continue to provide a native `headers` table for
backward compatibility. Source:
`packages/bindings/src/fetch/pollProtocol.ts`,
`packages/bindings/fnl/fen/util/http/backends/fetch.fnl`.

`host.kv` operations are fast and don't stream, so they don't need the
poll shape — see [kv.md](kv.md) for how that bridge differs. The `HostKv`
interface deliberately leaves the coroutine-resume mechanism to
`packages/runtime` rather than deciding it in `packages/bindings`
(`packages/bindings/src/kv/types.ts:7-19`).

## fetch_abort (wired, optional per transport)

`__fen_host.fetch_abort(id)` is the mid-turn cancellation seam. It calls the
poller's `abort(id)`, which invokes the transport's optional per-request abort
registration when available and marks that poll state as
`{error: "cancelled", done: true}` without deleting it. Keeping the state
until the Fennel loop polls it preserves any chunks already streamed and lets
the normal `fetch_dispose` terminal branch release the poll state. The web
transport registers its private `AbortController`; other `HostFetch`
implementations may ignore the registration while still receiving the
terminal poll result. `FetchPoller.abortAll()` is used by the page Stop/Esc
path.

A cancellation-aware Fennel request disposes before yielding the cancellation
marker, because the marker unwinds the request coroutine. This prevents a
cancelled poll id from leaking and ensures the provider does not render the
transport abort as an ordinary error.

## fetch_dispose (wired, mandatory)

`__fen_host.fetch_dispose(id)` drops the JS-side terminal state for a
completed request (`FetchPoller.dispose` in
`packages/bindings/src/fetch/pollProtocol.ts`). `fetch.fnl`'s `request`
calls it on every terminal branch of the poll loop — not optional cleanup:
without it, `FetchPoller`'s internal map grows by one entry per HTTP call
for the life of the VM, since request ids are never reused. The runtime
package wires `fetch_start`/`fetch_poll`/`fetch_abort`/`fetch_dispose` to a
shared `FetchPoller` instance's `start`/`poll`/`abort`/`dispose` methods, in
that order.

`dispose` (and the poller-level `disposeAll()`, the VM-teardown seam
called before `rt.close()`) also releases any producer parked on a
backpressure promise by rejecting it with `FetchPollerDisposedError`
(`code: "FETCH_POLLER_DISPOSED"`), so the host's `finally` runs and the
underlying reader/connection is cancelled rather than leaked.

## Response text and byte discipline

The fetch response path carries UTF-8 **text**. `WebHostFetch` and
`ScriptedFetch` use one `TextDecoder("utf-8")` per response with streaming mode
for each wire chunk and a final flush, so a browser chunk boundary may split a
multi-byte sequence without corrupting it. `onChunk` and terminal `body` are
ordinary JS strings containing that decoded text. Wasmoon then UTF-8-encodes
the strings when they cross into Lua, reproducing valid response wire bytes
exactly; this is the same text direction as the request contract.

Binary response bodies are not supported through this string path. A binary
API would need to expose byte arrays rather than Lua strings. When
`accumulateBody` is false, `ACCUMULATE_BODY_CAP` remains a byte cap measured
in UTF-8 bytes. The host keeps only complete Unicode characters, so a cap that
would split a multi-byte character truncates immediately before that
character. The poll handoff queue uses the same UTF-8 byte accounting.

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

The same hard boundary applies to `preview_rpc_poll`: its `result.value` is
already JSON text for every non-string value before the poll object reaches
Wasmoon. String values remain unquoted text so the model sees the existing
human-readable result, and an absent value remains absent. `WebHostPreview`,
`FakePreview`, and the `apps/web/src/boot.ts` host seam all preserve this
contract; the Fennel `rpc-result->tool` wrapper rejects any other value rather
than passing proxy userdata to cjson.

The notification seam follows the same one-way rule. `__fen_host.notify(title,
body?)` returns a JSON-text result, never a JavaScript object. The host checks
`Notification.permission` but does not call `requestPermission`; the shell
settings panel owns that call and invokes it only from a user gesture. The
host rate-limits attempts (currently one per three seconds). Permission
denial, an absent API, or an unsupported browser returns a fallback result
for the Fennel tool to surface as an in-app transcript notice.
