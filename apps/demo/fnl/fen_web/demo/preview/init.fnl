;; Sandboxed-iframe preview tools (fen-web#8): the differentiator from
;; fen#99 — the agent drives the very app it just built in the virtual FS.
;;
;; This is a demo-only extension: it registers preview.refresh / preview.query
;; / preview.click / preview.fill / preview.eval / preview.screenshot through
;; the ordinary public :tool register kind (fen.core.extensions.register.tool),
;; loaded via the per-owner manifest loader (fen_web.demo.boot.load-extension!),
;; exactly like the file tools. Owner cleanup and reload therefore apply, and
;; the tools are scoped to the demo owner rather than added on an ad-hoc path.
;;
;; refresh re-renders the vfs tree into the iframe (host.preview.set-html);
;; the other five drive the running app over the postMessage RPC channel
;; (host.preview rpc start/poll/dispose). The RPC is asynchronous (a round
;; trip to another execution context), so — like the fetch backend — each
;; tool polls and yields the turn coroutine between polls rather than blocking
;; (docs/bindings/preview.md, docs/bindings/host-protocol.md).
;;
;; SECURITY: user JS in the iframe cannot reach the parent FS, API key, or
;; forge token — the iframe is allow-scripts with NO allow-same-origin and the
;; only channel is this RPC surface (enforced by host.preview). These tools
;; never post any secret into the iframe; they carry only selectors/values/
;; expressions.

(local util (require :fen_web.tools.util))
(local html (require :fen_web.demo.preview.html))
(local json (require :fen.util.json))

(local M {})

(fn get-host []
  (let [host _G.__fen_host]
    (if host host (error "fen_web.demo.preview: __fen_host is not installed"))))

;; @doc fen_web.demo.preview.rpc!
;; kind: function
;; signature: (rpc! req ?yield-fn) -> {:ok bool :value any :error string}
;; summary: Run one preview RPC over host.preview's async start/poll/dispose bridge, yielding the turn coroutine between polls (mirroring the fetch backend). Requires a cooperative yield-fn when the reply is not immediate; errors clearly otherwise so it never hot-spins.
;; tags: preview rpc host yield
(fn M.rpc! [req ?yield-fn]
  (let [host (get-host)
        id (host.preview_rpc_start req)]
    (var result nil)
    (while (not result)
      (let [poll (host.preview_rpc_poll id)]
        (if poll.done
            (do (host.preview_rpc_dispose id)
                (set result (or poll.result {:ok false :error "empty preview result"})))
            ?yield-fn (?yield-fn)
            (do (host.preview_rpc_dispose id)
                (error "preview RPC requires a cooperative turn (no yield-fn)")))))
    result))

(fn rpc-result->tool [r]
  (if (not r.ok)
      (util.err (or r.error "preview RPC failed"))
      (util.ok (if (= (type r.value) :string)
                   r.value
                   (json.encode (if (= r.value nil) json.null r.value))))))

;; --- Tool specs ---------------------------------------------------------

(local refresh-tool
  {:name :preview.refresh
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
  {:name :preview.query
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
  {:name :preview.click
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
                  (rpc-result->tool (M.rpc! {:method :click :selector args.selector} ?yield))))})

(local fill-tool
  {:name :preview.fill
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
                             :value (or args.value "")} ?yield))))})

(local eval-tool
  {:name :preview.eval
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
                  (rpc-result->tool (M.rpc! {:method :eval :expr args.expr} ?yield))))})

(local screenshot-tool
  {:name :preview.screenshot
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
  [refresh-tool query-tool click-tool fill-tool eval-tool screenshot-tool])

;; @doc fen_web.demo.preview.register
;; kind: function
;; signature: (register api) -> true
;; summary: Register the demo-only preview.refresh/query/click/fill/eval/screenshot tools through the per-owner :tool register kind, with :always exposure so the agent can drive its freshly built app without a tool_search gate.
;; tags: preview tools register extension
(fn M.register [api]
  (each [_ spec (ipairs tool-specs)]
    (set spec.exposure :always)
    (api.register :tool spec))
  true)

M
