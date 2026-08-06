;; Browser fetch() backend for fen.util.http, backing fen-web (fen#99).
;;
;; This is the translation point between fen's kebab-case opts/results
;; (`:timeout-ms`, `:on-chunk`, `:accumulate-body?`, ...) and the JS host
;; primitive. Timeout defaults and blocking-capability policy belong to
;; fen.util.http.request; this backend only transports the resolved fields.
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
;; provider extra-headers / browser-direct option upstream in fen, filed as
;; the upstream ask acmiyaguchi/fen#492 per docs/architecture/seams.md's
;; "widen the seam in fen" rule; once that lands, this moves to the provider
;; spec and this host-keyed special-case is deleted. The host match is exact
;; (see anthropic-host? below), so a lookalike host like
;; https://api.anthropic.com.attacker.example never receives the header.
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

;; Timeout fields are filled by fen.util.http.request at the seam owner;
;; backends receive them as always-present values (fen#469).
;; Add the browser-only CORS opt-in header for direct-from-page Anthropic
;; calls (see this file's header comment for why it lives here, not the
;; provider). Keyed on the Anthropic host so no other provider is touched;
;; never overwrites a header the caller already set.
(local ANTHROPIC-DIRECT-HEADER :anthropic-dangerous-direct-browser-access)

;; Exact host match: only https (never plain http), only the literal host
;; api.anthropic.com, and the character after ".com" must be a real URL
;; boundary (`/`, `:`, `?`, `#`) or end-of-string. This rejects both
;; http://api.anthropic.com and suffix lookalikes such as
;; https://api.anthropic.com.attacker.example.
(fn anthropic-host? [url]
  (let [u (tostring (or url ""))]
    (or (= u "https://api.anthropic.com")
        (not= nil (string.find u "^https://api%.anthropic%.com[/:?#]")))))

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
   :timeoutMs opts.timeout-ms
   :connectTimeoutMs opts.connect-timeout-ms
   :idleTimeoutMs opts.idle-timeout-ms
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

;; Capability declaration (#471): the browser transport is structurally
;; cooperative-only. fen.util.http.request uses this to return its canonical
;; capability error before dispatch when a caller omits opts.yield.
(local capabilities {:blocking? false})

{: request : capabilities}
