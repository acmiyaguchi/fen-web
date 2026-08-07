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
  body?: string;  // Lua-byte-string encoded; see bytes.ts
  timeoutMs?: number; connectTimeoutMs?: number; idleTimeoutMs?: number;
  onChunk?: (bytes: string) => void | PromiseLike<void>;
  accumulateBody?: boolean;  // default true; false retains only ACCUMULATE_BODY_CAP bytes
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

`opts.body` (if present) is Lua-byte-string encoded (one JS UTF-16 code
unit per byte, per [host-protocol.md](host-protocol.md)'s latin1
discipline). `webFetch.ts` decodes it back to raw bytes with
`fromLuaBytes` and passes a `Uint8Array` as the `fetch()` body — passing
the Lua string straight through would let `fetch()` re-encode it as
UTF-8, double-encoding any non-ASCII byte.

## accumulateBody

Streaming callers (SSE) pass `accumulate-body? false` in Fennel
(`accumulateBody: false` in TS) and rely on `on-chunk`/`onChunk`; default
is `true`. When `false`, `webFetch.ts` still streams every chunk through
`onChunk` but retains only a bounded head of the body — capped at
`ACCUMULATE_BODY_CAP` (65536 bytes) — instead of the full response,
matching the native backend's `FEN_ERROR_BODY_CAP` contract; the retained
head is for error diagnostics, not a substitute buffered body. The
Fennel backend (`fetch.fnl`) never reconstructs a body from `on-chunk`
chunks in either mode — it passes `p.body` straight through (the host's
full accumulation, or the bounded head when `accumulate-body?` is false),
so the body is held exactly once, host-side.

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

See [host-protocol.md](host-protocol.md) for the full `fetch_start`/
`fetch_poll`/`fetch_dispose` protocol. Poll bridging lives in
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
