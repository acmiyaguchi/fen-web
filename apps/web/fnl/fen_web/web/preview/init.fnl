;; Sandboxed-iframe preview tools (fen-web#8): the differentiator from
;; fen#99 — the agent drives the very app it just built in the virtual FS.
;;
;; This is a demo-only extension: it registers preview_refresh / preview_query
;; / preview_click / preview_fill / preview_eval / preview_screenshot /
;; preview_console through
;; the ordinary public :tool register kind (fen.core.extensions.register.tool),
;; loaded via the per-owner manifest loader (fen_web.web.boot.load-extension!),
;; exactly like the file tools. Owner cleanup and reload therefore apply, and
;; the tools are scoped to the demo owner rather than added on an ad-hoc path.
;;
;; refresh re-renders the vfs tree into the iframe (host.preview.set-html);
;; the other five drive the running app over the postMessage RPC channel
;; (host.preview rpc start/poll/dispose). The RPC is asynchronous (a round
;; trip to another execution context), so — like the fetch backend — each
;; tool polls and yields the turn coroutine between polls rather than blocking
;; (docs/bindings/preview.md, docs/bindings/host-protocol.md). Unlike
;; host.fetch, which bounds itself with host-side timeouts surfaced as
;; poll.done+error, host.preview's poll has no host-side timeout, so M.rpc!
;; enforces the liveness bound in Fennel: a preview that never replies (e.g.
;; a blank iframe driven before preview_refresh) surfaces a structured
;; {:ok false :error ...} rather than yielding the turn forever.
;;
;; SECURITY: user JS in the iframe cannot reach the parent FS, API key, or
;; forge token — the iframe is allow-scripts with NO allow-same-origin and the
;; only channel is this RPC surface (enforced by host.preview). These tools
;; never post any secret into the iframe; they carry only selectors/values/
;; expressions.

(local util (require :fen_web.tools.util))
(local html (require :fen_web.web.preview.html))
(local json (require :fen.util.json))

(local M {})

;; Liveness bound for a single preview RPC (see the header note): wall-clock
;; deadline plus a hard poll ceiling so a preview that never replies (e.g. a
;; blank iframe driven before preview_refresh) surfaces a structured error
;; rather than yielding the turn coroutine forever. Overridable per call via
;; the ?opts arg (tests pass a tiny :max-polls to exercise the timeout path).
(local DEFAULT-TIMEOUT-S 30)
(local DEFAULT-MAX-POLLS 1000000)

(fn get-host []
  (let [host _G.__fen_host]
    (if host host (error "fen_web.web.preview: __fen_host is not installed"))))

;; @doc fen_web.web.preview.rpc!
;; kind: function
;; signature: (rpc! req ?yield-fn ?opts) -> {:ok bool :value any :error string}
;; summary: Run one preview RPC over host.preview's async start/poll/dispose bridge, yielding the turn coroutine between polls (like the fetch backend, but with the liveness bound enforced here in Fennel since host.preview has no host-side timeout). Requires a cooperative yield-fn when the reply is not immediate; on a timeout or missing yield-fn it disposes and returns a structured {:ok false :error ...} so a never-answering preview surfaces a tool error rather than hanging the turn. ?opts overrides {:timeout-s :max-polls} for tests.
;; tags: preview rpc host yield timeout
(fn M.rpc! [req ?yield-fn ?opts]
  (let [opts (or ?opts {})
        timeout-s (or opts.timeout-s DEFAULT-TIMEOUT-S)
        max-polls (or opts.max-polls DEFAULT-MAX-POLLS)
        host (get-host)
        id (host.preview_rpc_start req)
        deadline (+ (os.time) timeout-s)]
    (var result nil)
    (var polls 0)
    (while (not result)
      (set polls (+ polls 1))
      (let [poll (host.preview_rpc_poll id)]
        (if poll.done
            (do (host.preview_rpc_dispose id)
                (set result (or poll.result {:ok false :error "empty preview result"})))
            ;; Liveness cap: a preview that never answers (a blank iframe
            ;; driven before preview_refresh) would otherwise poll forever.
            ;; Surface the timeout as the same {:ok false :error ...} shape a
            ;; real RPC failure uses, so the tools return a structured error.
            (or (>= (os.time) deadline) (>= polls max-polls))
            (do (host.preview_rpc_dispose id)
                (set result
                     {:ok false
                      :error (.. "preview RPC timed out with no reply — did you "
                                 "run preview_refresh first? A blank preview "
                                 "never answers.")}))
            ?yield-fn (?yield-fn)
            (do (host.preview_rpc_dispose id)
                (error "preview RPC requires a cooperative turn (no yield-fn)")))))
    result))

(fn unread-uncaught-count []
  (let [host (get-host)
        count-fn host.preview_console_uncaught_count]
    (if (= (type count-fn) :function)
        (or (count-fn) 0)
        0)))

(fn uncaught-marker []
  (let [count (unread-uncaught-count)]
    (when (> count 0)
      (.. "\n\n" (tostring count)
          (if (= count 1) " uncaught error since last check (use preview_console)"
              " uncaught errors since last check (use preview_console)")))))

(fn rpc-result->tool [r ?surface-errors?]
  (let [marker (when ?surface-errors? (uncaught-marker))]
    (if (not r.ok)
        (util.err (.. (or r.error "preview RPC failed") (or marker "")))
        (let [text (if (= (type r.value) :string)
                       r.value
                       (json.encode (if (= r.value nil) json.null r.value)))]
          (util.ok (.. text (or marker "")))))))

(local console-tool
  {:name :preview_console
   :label "Preview console"
   :snippet "Read new preview console entries and uncaught errors"
   :description (.. "Read console.log/warn/error/info/debug output and uncaught "
                    "errors from the running preview iframe since the last "
                    "preview_console call or preview_refresh. Arguments are "
                    "defensively stringified and bounded; error entries include "
                    "their stack when available.")
   :parameters {:type :object :properties {}}
   :execute (fn [_args _ctx _yield]
              (let [host (get-host)
                    drain-fn host.preview_console_drain
                    entries (if (= (type drain-fn) :function)
                                (or (drain-fn) [])
                                [])]
                ;; The browser host returns JSON text, not its JS array. A
                ;; wasmoon JS array crosses into Lua as proxy userdata, which
                ;; cjson cannot encode; the host owns serialization at this
                ;; boundary. Keep the table fallback for Fennel-side doubles.
                (if (= (type entries) :string)
                    (util.ok entries)
                    (= (type entries) :table)
                    (util.ok (json.encode (if (> (length entries) 0)
                                               entries
                                               json.empty-array)))
                    ;; A wasmoon JS array is proxy userdata. It must never
                    ;; reach cjson; the browser host's contract is JSON text.
                    (util.err "preview console host returned non-JSON data"))))})

;; --- Tool specs ---------------------------------------------------------

(local refresh-tool
  {:name :preview_refresh
   :label "Preview refresh"
   :snippet "Render the workspace app into the preview iframe"
   :description (.. "Render (or re-render) the workspace app into the sandboxed "
                    "preview iframe from the virtual filesystem. Reads the entry "
                    "file (default /index.html) and inlines same-tree stylesheet "
                    "and script references so the page runs standalone. Call this "
                    "after writing/editing files to see changes, before driving "
                    "the app with the other preview.* tools.")
   :parameters {:type :object
                :properties {:entry {:type :string
                                     :description "Entry HTML path in the workspace (default /index.html)"}}}
   :execute (fn [args _ctx _yield]
              (let [kv (util.get-kv)
                    entry (if (and args.entry (not= args.entry "")) args.entry "/index.html")
                    (page found?) (html.build-page kv entry)
                    host (get-host)]
                (host.preview_set_html page)
                (util.ok (if found?
                             (.. "preview refreshed from " entry
                                 " (" (tostring (length page)) " bytes)")
                             (.. "preview refreshed, but no entry file at " entry
                                 " — showing a placeholder page")))))})

(local query-tool
  {:name :preview_query
   :label "Preview query"
   :snippet "Inspect a preview element by CSS selector"
   :description (.. "Query the running preview app: return whether a CSS selector "
                    "matches, how many elements match, and the first match's tag "
                    "text/value/outerHTML. Use it to assert the app rendered what "
                    "you expected.")
   :parameters {:type :object
                :properties {:selector {:type :string
                                        :description "CSS selector to query in the preview document"}}
                :required [:selector]}
   :execute (fn [args _ctx ?yield]
              (if (or (not args.selector) (= args.selector ""))
                  (util.err "missing 'selector'")
                  (rpc-result->tool (M.rpc! {:method :query :selector args.selector} ?yield))))})

(local click-tool
  {:name :preview_click
   :label "Preview click"
   :snippet "Click a preview element by CSS selector"
   :description "Click the first element matching a CSS selector in the preview app."
   :parameters {:type :object
                :properties {:selector {:type :string
                                        :description "CSS selector of the element to click"}}
                :required [:selector]}
   :execute (fn [args _ctx ?yield]
              (if (or (not args.selector) (= args.selector ""))
                  (util.err "missing 'selector'")
                  (rpc-result->tool (M.rpc! {:method :click :selector args.selector} ?yield) true)))})

(local fill-tool
  {:name :preview_fill
   :label "Preview fill"
   :snippet "Set a preview input's value by CSS selector"
   :description (.. "Set the value of the first input/textarea/select matching a "
                    "CSS selector in the preview app and dispatch input/change "
                    "events so the app reacts as if the user typed.")
   :parameters {:type :object
                :properties {:selector {:type :string
                                        :description "CSS selector of the field to fill"}
                             :value {:type :string
                                     :description "Value to set on the field"}}
                :required [:selector :value]}
   :execute (fn [args _ctx ?yield]
              (if (or (not args.selector) (= args.selector ""))
                  (util.err "missing 'selector'")
                  (rpc-result->tool
                    (M.rpc! {:method :fill :selector args.selector
                             :value (or args.value "")} ?yield) true)))})

(local eval-tool
  {:name :preview_eval
   :label "Preview eval"
   :snippet "Evaluate a JS expression in the preview app"
   :description (.. "Evaluate a JavaScript expression inside the sandboxed "
                    "preview iframe and return the JSON-serialized result. Runs "
                    "in the app's own context (allow-scripts, no same-origin), so "
                    "it can read app state but cannot reach the parent page, the "
                    "filesystem, or your API key.")
   :parameters {:type :object
                :properties {:expr {:type :string
                                    :description "JavaScript expression to evaluate in the preview"}}
                :required [:expr]}
   :execute (fn [args _ctx ?yield]
              (if (or (not args.expr) (= args.expr ""))
                  (util.err "missing 'expr'")
                  (rpc-result->tool (M.rpc! {:method :eval :expr args.expr} ?yield) true)))})

(local screenshot-tool
  {:name :preview_screenshot
   :label "Preview screenshot"
   :snippet "Capture a preview canvas as a data URL"
   :description (.. "Capture a <canvas> in the preview app as a PNG data URL "
                    "(canvas.toDataURL). Pass a selector to pick a specific "
                    "canvas; otherwise the first canvas is used.")
   :parameters {:type :object
                :properties {:selector {:type :string
                                        :description "Optional CSS selector for the canvas (default: first canvas)"}}}
   :execute (fn [args _ctx ?yield]
              (rpc-result->tool
                (M.rpc! {:method :screenshot :selector (?. args :selector)} ?yield)))})

(local tool-specs
  [refresh-tool query-tool click-tool fill-tool eval-tool screenshot-tool console-tool])

;; Build a fresh spec table with :always exposure rather than mutating the
;; shared module-level singleton in tool-specs (which register would otherwise
;; re-mutate on every call / hot-reload).
(fn with-always-exposure [spec]
  (let [s (collect [k v (pairs spec)] k v)]
    (set s.exposure :always)
    s))

;; @doc fen_web.web.preview.register
;; kind: function
;; signature: (register api) -> true
;; summary: Register the demo-only preview_refresh/query/click/fill/eval/screenshot/console tools through the per-owner :tool register kind, with :always exposure so the agent can drive its freshly built app without a tool_search gate. Registers fresh spec tables so the shared module-level specs are never mutated.
;; tags: preview tools register extension
(fn M.register [api]
  (each [_ spec (ipairs tool-specs)]
    (api.register :tool (with-always-exposure spec)))
  true)

M
