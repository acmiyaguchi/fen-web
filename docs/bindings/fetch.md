# fetch (`host.fetch`)

Implements fen's HTTP backend contract for the browser. Two halves:
`packages/bindings/src/fetch/*.ts` (transport) and
`packages/bindings/fnl/fen/util/http/backends/fetch.fnl` (policy,
translation, fen-facing interface). Status: implemented, landed on `main`
at commit `02f4b1a` (closes issue #2).

## Backend contract (fen side)

fen's seam is `fen/packages/util/src/fen/util/http/backend.fnl` — a
backend is `{:request (fn [opts])}`, 11 lines. The default accumulate
behavior is documented in `fen/packages/util/src/fen/util/http/init.fnl`.
The fetch backend is installed by pre-setting
`package.loaded["fen.util.http.backend"]` from the runtime bootstrap, not
by patching the interface file — same mechanism as
`fen.testing.stub-http!`.

## Shapes

TS (`packages/bindings/src/fetch/types.ts`) — camelCase:

```ts
interface FetchRequestOptions {
  method: string; url: string; headers?: Record<string,string>;
  body?: string;  // JS text after wasmoon UTF-8 string marshalling
  timeoutMs?: number; connectTimeoutMs?: number; idleTimeoutMs?: number;
  onChunk?: (text: string) => void | PromiseLike<void>;
  accumulateBody?: boolean;  // default true; false retains only a UTF-8-byte-capped head
  registerAbort?: (abort: () => void) => void;  // optional transport cancellation registration
}
const ACCUMULATE_BODY_CAP = 65536;  // mirrors native FEN_ERROR_BODY_CAP
type FetchResult = { status: number; headers: Record<string,string>; body: string }
                  | { error: string };
// Backpressure contract: when onChunk returns a promise the host MUST await
// it before delivering the next chunk. A host that ignores it and enqueues
// re-entrantly gets a synchronous FetchPollerBackpressureError — loud
// failure, never silent chunk loss. `body` is required on success: the host
// owns the single accumulated copy (full body, or the capped head when
// accumulateBody is false). The idle watchdog measures server silence only;
// time parked on consumer backpressure never counts toward idleTimeoutMs.
```

Fennel (`fetch.fnl` `translate`) — kebab-case, mirroring
`fen.util.http.init`'s opts: `:timeout-ms`, `:connect-timeout-ms`,
`:idle-timeout-ms`, `:on-chunk`, `:accumulate-body?` (translated to
`accumulateBody`). The `.fnl` file is the sole translation point between
the two conventions; TS never sees kebab-case keys.

## Timeout defaults (Fennel side)

`translate` in `fetch.fnl` applies fen's documented defaults — matching
the native libcurl backend's defaults, sourced from `fen_http.c` — when
the caller omits a value: `timeout-ms` 600000, `connect-timeout-ms`
30000, `idle-timeout-ms` 60000. The TS transport stays policy-free and
only ever sees resolved values; it does not itself default anything.

## Timeout semantics (TS side, `webFetch.ts`)

Three independent timers share one `AbortController`; whichever fires
first aborts the fetch:

- **`connectTimeoutMs`** bounds only the pre-response phase (DNS/TCP/TLS
  through the first byte of headers). Its timer is cleared as soon as
  `fetch()` resolves with a `Response` — a slow-but-healthy stream past
  that point is not subject to it.
- **`timeoutMs`** bounds the entire request, connect phase through the
  last streamed byte, and stays armed for the whole call.
- **`idleTimeoutMs`** is a separate watchdog that resets on every
  received chunk (including the initial response headers) and aborts if
  no bytes arrive within the window.

This is a two-timer-phase model, not the single `min(timeoutMs,
connectTimeoutMs)` deadline an earlier draft used — connect and overall
now have genuinely different scopes.

## Request body encoding

`opts.body` is ordinary text when it reaches the JS host. Wasmoon owns Lua
↔ JS string encoding and UTF-8-transcodes strings in both directions; the
Fennel layer never hands latin1-coded bytes to JS through wasmoon. Both
`WebHostFetch` and `ScriptedFetch` therefore pass the body string through
`fromLuaBytes`, which unconditionally uses `TextEncoder` to produce UTF-8
wire bytes. For example, `"café"` becomes `[63, 61, 66, c3, a9]`, and
`"—"` becomes `[e2, 80, 94]`.

This is a text-body contract, not a general binary-body transport. If a
genuinely binary request body is needed, it must cross the Lua boundary as a
table of byte numbers; that contract is documented for future work and is
not implemented here.

## Request headers

Headers are not Lua byte strings. This transport applies a strict ASCII-only
contract to header names and values and rejects a request with a non-ASCII
entry before calling browser `fetch()` (the scripted transport applies the
same check). It does not pass non-ASCII header values through a byte
conversion or silently sanitize them: HTTP header metadata must be supplied
as valid ASCII by the Fennel/provider layer. The rejection is returned as the
usual `{error}` fetch result.

## Response text encoding and streaming

Responses on this path are UTF-8 **text**, not arbitrary binary data. `WebHostFetch`
keeps one `TextDecoder("utf-8")` alive for the entire response and calls
`decode(chunk, {stream: true})` for every wire chunk, then flushes it after the
stream ends. This preserves a multi-byte character when the browser splits its
bytes across reads. `ScriptedFetch` applies the same normalization: fixture
strings are UTF-8 encoded as wire bytes, and fixture `Uint8Array`s are treated
as raw wire bytes before going through the same streaming decoder.

`onChunk` receives ordinary JS text, and `body` is the concatenation of that
same decoded text. Wasmoon owns the next boundary crossing and UTF-8-encodes
these strings into Lua, so valid UTF-8 response bytes (including `café`, em
dashes, emoji, and CJK) arrive in Lua byte-for-byte unchanged. Empty text chunks
are possible when a wire chunk contains only the prefix of a split character.
Binary response bodies are not supported through this string path; a future
binary contract would need byte arrays rather than Lua strings.

## accumulateBody

Streaming callers (SSE) pass `accumulate-body? false` in Fennel
(`accumulateBody: false` in TS) and rely on `on-chunk`/`onChunk`; default
is `true`. When `false`, `webFetch.ts` still streams every decoded text chunk
through `onChunk` but retains only a bounded head of the body — capped at
`ACCUMULATE_BODY_CAP` (65536 **UTF-8 bytes**) — instead of the full response,
matching the native backend's `FEN_ERROR_BODY_CAP` contract; the retained head
is for error diagnostics, not a substitute buffered body. If the cap would
fall inside a multi-byte character, the transport omits that character and
stops at the preceding Unicode character boundary. The Fennel backend
(`fetch.fnl`) never reconstructs a body from `on-chunk` chunks in either mode —
it passes `p.body` straight through (the host's full accumulation, or the
bounded head when `accumulate-body?` is false), so the body is held exactly
once, host-side.

## Anthropic direct-browser CORS header (interim)

Provider-level headers normally belong to the Fennel provider/policy layer
that builds `opts.headers` (same as the native backend). The one exception
lives in `fetch.fnl`'s `translate`: for `api.anthropic.com` it adds
`anthropic-dangerous-direct-browser-access: true`, the header that opts a
request into CORS from a page. It sits in the fetch backend, keyed strictly
on the Anthropic host, because (a) it is a property of *this* transport
(the native libcurl backend never needs it) and (b) fen's pinned Anthropic
provider exposes no extra-header seam to set it from the provider layer. It
never overwrites a caller-set header. This is interim: the durable fix is a
provider extra-headers / browser-direct option upstream in fen (per
[../architecture/seams.md](../architecture/seams.md)'s "widen the seam in
fen" rule); once that lands, this moves to the provider spec and the
host-keyed special-case is deleted. Covered by
`packages/bindings/tests/fetch_test.fnl`.

## Poll protocol and cooperative-only mode

### Mid-request cancellation

`FetchPoller.abort(id)` is exposed to the host as `__fen_host.fetch_abort(id)`.
It invokes the optional `registerAbort` callback supplied to that request (the
browser transport registers its `AbortController.abort()`), marks the poll
state terminal with `{error: "cancelled"}`, and leaves the state available for
one final poll. The Fennel backend disposes that id and yields the cancellation
through fen's cooperative agent seam, so a stopped turn emits `:cancelled`
instead of an ordinary provider error. `abortAll()` is used by the page's
`DemoSession.cancel()` path; `disposeAll()` also aborts in-flight transports
before VM close or fatal cleanup. `ScriptedFetch` implements the same optional
registration for node and browser-test parity.

The host table includes:

```text
fetch_abort(id) -> nil
```

Unknown ids are harmless. Calling it while idle is a no-op because there are
no live poll states.

`fetch_poll` terminal results carry response headers as `headers-json`,
host-owned JSON text serialized by the JS host. This is the same hard
never-let-a-JS-proxy-reach-Lua invariant as `preview_console_drain` (see
[preview.md](preview.md)): wasmoon exposes nested JS objects as proxy userdata,
and `pairs()` on that userdata throws—the mechanism behind issue #65. The
Fennel fetch backend and the `web_fetch` tool decode `headers-json` before
inspection. Pure-Fennel hosts may continue to provide a native `headers`
table for backward compatibility.

`packages/bindings/src/fetch/pollProtocol.ts` (`FetchPoller`).

`request` in `fetch.fnl` now **requires `opts.yield`** and errors
immediately if it's missing, rather than supporting a blocking mode. fen
does have real blocking call shapes (e.g. `fen.update`, or any request
made outside a `core.agent.make-yield`-driven coroutine), but a tight
`while (not done) (fetch_poll id)` loop with no yield would busy-spin
without ever letting the browser event loop progress the pending
`host.fetch` promise, hard-hanging the tab. Erroring clearly beats a
frozen tab; a future `__fen_host.fetch_await(id)` (blocking sleep/poll
bridge) could restore blocking-mode support once the runtime's coroutine
bridge supports it (see
[../runtime/boot.md](../runtime/boot.md)'s coroutine pump).

## Testing

- `ScriptedFetch` (`packages/bindings/src/fetch/stubFetch.ts`) — FIFO
  queue of scripted responses, including a `hang: true` mode for
  deterministic timeout tests (requires `opts.timeoutMs`).
- `WebHostFetch` (`packages/bindings/src/fetch/webFetch.ts`) — real
  `fetch()`, used in browser/Node-with-fetch environments.

See also: [host-protocol.md](host-protocol.md),
[../architecture/seams.md](../architecture/seams.md).
