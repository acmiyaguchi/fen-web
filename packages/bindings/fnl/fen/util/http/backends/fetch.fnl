;; Browser fetch() backend for fen.util.http, backing fen-web (fen#99).
;;
;; Mirrors fen.util.http.backends.native (the libcurl backend): this file
;; is the sole translation point between fen's kebab-case opts/results
;; (`:timeout-ms`, `:on-chunk`, `:accumulate-body?`, ...) and the JS host
;; primitive, and it owns policy (timeout defaults, accumulate-body?,
;; error shapes) — the JS side (packages/bindings) is transport only.
;;
;; Provider-level headers generally belong to the Fennel provider/policy
;; layer that builds `opts.headers` before calling fen.util.http.request,
;; same as with the native backend — this backend only transports whatever
;; headers it's given. The one exception is a *browser-transport* header
;; that is meaningless off-browser and that fen's pinned provider has no
;; option to set: Anthropic's `anthropic-dangerous-direct-browser-access:
;; true`, which opts a request into CORS from a page. It is added here,
;; keyed strictly on the api.anthropic.com host, because (a) it is a
;; property of *this* transport (the native libcurl backend never needs
;; it) and (b) fen's anthropic provider exposes no extra-header seam to set
;; it from the provider layer. This is interim: the durable fix is a
;; provider extra-headers / browser-direct option upstream in fen (filed as
;; an upstream ask, per docs/architecture/seams.md's "widen the seam in
;; fen" rule); once that lands, this moves to the provider spec and this
;; host-keyed special-case is deleted.
;;
;; Install by pre-setting package.loaded["fen.util.http.backend"] from the
;; runtime bootstrap (same mechanism fen.testing.stub-http! uses), not by
;; patching fen.util.http.backend itself.
;;
;; Why poll instead of callbacks: wasmoon runs the agent inside a Lua
;; coroutine, and Lua 5.4 cannot yield across a C-call boundary — a plain
;; JS->Lua callback fired from inside a pending host.fetch promise would
;; attempt exactly that if it tried to resume the coroutine. To avoid it,
;; the JS side never calls back into Lua directly. Instead:
;;
;;   1. `__fen_host.fetch_start(opts)` kicks off a promise-based
;;      host.fetch and immediately returns a request id (no blocking).
;;   2. This backend loop calls `__fen_host.fetch_poll(id)` repeatedly,
;;      each call draining any chunks buffered since the last poll and
;;      reporting {:chunks :done :status :headers :body :error}.
;;   3. Between polls (while not done) it calls opts.yield, so the VM
;;      cooperates instead of busy-looping the poll from inside a single
;;      Lua call.
;;   4. Once terminal, `__fen_host.fetch_dispose(id)` releases the JS-side
;;      buffered state for the request so it doesn't grow unboundedly
;;      across the VM's lifetime.
;;
;; Blocking mode (no opts.yield) is a real fen call shape — e.g.
;; fen.update and any request made outside a coroutine driven by
;; core.agent.make-yield — but the browser event loop only progresses JS
;; promises (including host.fetch's) between Lua's synchronous calls. A
;; tight `while (not done) (h.fetch_poll id)` loop with no yield would
;; therefore busy-spin forever without ever letting the pending
;; host.fetch promise resolve, hard-hanging the tab. Rather than freeze
;; silently, this backend requires opts.yield and errors clearly when
;; it's missing. (A future option is an unconditional host-provided tick
;; — e.g. __fen_host.fetch_await(id) backed by a blocking sleep/poll
;; bridge in the runtime package — but that needs the runtime's coroutine
;; bridge to exist first; erroring now beats a frozen tab.)

(fn request-fetch-error [msg]
  (error (.. "fen.util.http.backends.fetch: " msg)))

(fn host []
  (or _G.__fen_host (request-fetch-error "__fen_host is not installed")))

;; Match fen.util.http.init's documented defaults (also the native
;; backend's defaults, sourced from fen_http.c): overall 600000ms,
;; connect 30000ms, idle-watchdog 60000ms. The TS transport
;; (packages/bindings) stays policy-free and only sees the resolved
;; values below.
(local default-timeout-ms 600000)
(local default-connect-timeout-ms 30000)
(local default-idle-timeout-ms 60000)

;; Add the browser-only CORS opt-in header for direct-from-page Anthropic
;; calls (see this file's header comment for why it lives here, not the
;; provider). Keyed on the Anthropic host so no other provider is touched;
;; never overwrites a header the caller already set.
(local ANTHROPIC-DIRECT-HEADER :anthropic-dangerous-direct-browser-access)

(fn anthropic-host? [url]
  (not= nil (string.find (tostring (or url "")) "^https?://api%.anthropic%.com")))

(fn transport-headers [opts]
  (let [headers {}]
    (each [k v (pairs (or opts.headers {}))] (tset headers k v))
    (when (and (anthropic-host? opts.url)
               (= nil (. headers ANTHROPIC-DIRECT-HEADER)))
      (tset headers ANTHROPIC-DIRECT-HEADER "true"))
    headers))

(fn translate [opts]
  {:method (or opts.method :GET)
   :url opts.url
   :headers (transport-headers opts)
   :body opts.body
   :timeoutMs (or opts.timeout-ms default-timeout-ms)
   :connectTimeoutMs (or opts.connect-timeout-ms default-connect-timeout-ms)
   :idleTimeoutMs (or opts.idle-timeout-ms default-idle-timeout-ms)
   ;; Tell the host whether to bound its own body accumulation (see
   ;; webFetch.ts's ACCUMULATE_BODY_CAP): keeps the JS side from holding a
   ;; full unbounded body when the caller only wants a diagnostics head.
   :accumulateBody (if (= opts.accumulate-body? nil) true opts.accumulate-body?)})

;; @doc fen.util.http.backends.fetch.request
;; kind: function
;; signature: (request opts) -> {:status :body :headers}|{:error}
;; summary: Drive host.fetch through the fetch_start/fetch_poll/fetch_dispose protocol, yielding cooperatively between polls.
;; tags: util http fetch browser
(fn request [opts]
  (when (not opts.yield)
    (request-fetch-error
      "requires cooperative mode (opts.yield) — blocking browser fetch would hard-hang the tab; see this file's header comment"))
  (let [h (host)
        id (h.fetch_start (translate opts))
        ;; Matches fen.util.http.init's documented default: accumulate the
        ;; body unless the caller explicitly opts out (streaming callers
        ;; pass false). When false, the host already caps what it hands
        ;; back in p.body (a bounded head for error diagnostics, matching
        ;; the native FEN_ERROR_BODY_CAP contract) — this backend must not
        ;; reconstruct a full body from chunks in that mode.
        accumulate? (if (= opts.accumulate-body? nil) true opts.accumulate-body?)
        body-parts []]
    (var result nil)
    (while (not result)
      (let [p (h.fetch_poll id)]
        (each [_ chunk (ipairs (or p.chunks []))]
          (when opts.on-chunk (opts.on-chunk chunk))
          (when accumulate? (table.insert body-parts chunk)))
        (if p.done
            (do
              (set result (if p.error
                              {:error p.error}
                              {:status p.status
                               :headers (or p.headers {})
                               :body (if accumulate? (table.concat body-parts) p.body)}))
              (h.fetch_dispose id))
            (opts.yield))))
    result))

{: request}
