;; Tests for the sandboxed-iframe preview extension (fen-web#8): the vfs->HTML
;; page assembler, the demo-only preview.* tool registration, and each tool's
;; behavior over a table-backed host.preview double (the Fennel stand-in for
;; packages/bindings/src/preview/fakePreview.ts — the Busted harness has no TS
;; runtime, mirroring the host.dom-apply fake in support.fnl).
;;
;; Security-invariant coverage: the no-leak spec asserts build-page emits ONLY
;; vfs content and never the API key stored under env/apikey/<VAR>.

(local support (require :support))
(local html (require :fen_web.web.preview.html))
(local preview (require :fen_web.web.preview))
(local json (require :fen.util.json))

;; A table-backed host.kv (same shape as packages/platform/tests/support.fnl's
;; make-kv), installed at _G.__fen_host.kv for the vfs the tools/builder read.
(fn make-kv []
  (let [store {}]
    {:get (fn [key] (. store key))
     :put (fn [key value] (tset store key value) nil)
     :delete (fn [key] (tset store key nil) nil)
     :list (fn [prefix]
             (let [prefix (or prefix "")
                   keys []]
               (each [k _ (pairs store)]
                 (when (= (string.sub k 1 (length prefix)) prefix)
                   (table.insert keys k)))
               (table.sort keys)
               keys))
     :__store store}))

;; A synchronous host.preview double: records set-html + rpc requests and
;; resolves each rpc immediately (done on the first poll), via a responder.
;; Match FakePreview/WebHostPreview: arbitrary values are JSON text before
;; rpc-result->tool receives them, so the test cannot accidentally hide the
;; Wasmoon proxy boundary with a native table.
(fn serialize-rpc-result [result]
  (if (not result)
      nil
      (let [out (collect [k v (pairs result)] k v)]
        (when (and (not= out.value nil)
                   (not= (type out.value) :string))
          (set out.value (json.encode out.value)))
        out)))

(fn make-preview [?responder]
  (let [responder (or ?responder (fn [_req] {:ok true}))
        h {:html nil :requests [] :results {} :next 1}]
    (set h.preview_set_html (fn [page] (set h.html page)))
    (set h.preview_rpc_start
         (fn [req]
           (table.insert h.requests req)
           (let [id h.next]
             (set h.next (+ id 1))
             (tset h.results id (responder req))
             id)))
    (set h.preview_rpc_poll
         (fn [id] {:done true :result (serialize-rpc-result (. h.results id))}))
    (set h.preview_rpc_dispose (fn [id] (tset h.results id nil)))
    (set h.console [])
    (set h.preview_console_drain
         (fn []
           (let [entries h.console]
             (set h.console [])
             (json.encode (if (> (length entries) 0)
                              entries
                              json.empty-array)))))
    (set h.preview_console_uncaught_count
         (fn []
           (var count 0)
           (each [_ entry (ipairs h.console)]
             (when entry.uncaught (set count (+ count 1))))
           count))
    h))

(fn install-host! [kv prev]
  (let [host {}]
    (when kv (set host.kv kv))
    (when prev
      (set host.preview_set_html prev.preview_set_html)
      (set host.preview_rpc_start prev.preview_rpc_start)
      (set host.preview_rpc_poll prev.preview_rpc_poll)
      (set host.preview_rpc_dispose prev.preview_rpc_dispose)
      (set host.preview_console_drain prev.preview_console_drain)
      (set host.preview_console_uncaught_count prev.preview_console_uncaught_count))
    (set _G.__fen_host host)
    host))

(fn text-of [result] (. result.content 1 :text))

(fn put-file [kv path content] (kv.put (.. "fs:" path) content))

(describe "fen-web demo preview extension"
  (fn []
    (after_each (fn [] (set _G.__fen_host nil)))

    (describe "html.build-page"
      (fn []
        (it "returns a friendly fallback (and false) when the entry is missing"
          (fn []
            (let [kv (make-kv)
                  (page found?) (html.build-page kv "/index.html")]
              (assert.is_false found?)
              (assert.is_truthy (string.find page "No preview entry" 1 true))
              (assert.is_truthy (string.find page "/index.html" 1 true)))))

        (it "builds the fallback for an entry path containing '%' without throwing"
          (fn []
            ;; Regression: entry is agent-supplied and was once used as a
            ;; string.gsub replacement, so a '%' threw \"invalid capture index\"
            ;; and unwound the (uncaught, cooperative) refresh turn.
            (let [kv (make-kv)
                  entry "/we%20ird%.html"
                  (ok? page found?) (pcall html.build-page kv entry)]
              (assert.is_true ok?)
              (assert.is_false found?)
              (assert.is_truthy (string.find page "No preview entry" 1 true))
              (assert.is_truthy (string.find page entry 1 true)))))

        (it "inlines same-tree stylesheet and script references from the vfs"
          (fn []
            (let [kv (make-kv)]
              (put-file kv "/index.html"
                        (.. "<!doctype html><html><head><meta charset=\"utf-8\">"
                            "<link rel=\"stylesheet\" href=\"style.css\">"
                            "</head><body><script src=\"app.js\"></script>"
                            "</body></html>"))
              (put-file kv "/style.css" "body{color:red}")
              (put-file kv "/app.js" "console.log('hi')")
              (let [(page found?) (html.build-page kv "/index.html")]
                (assert.is_true found?)
                (assert.is_truthy (string.find page "<style>" 1 true))
                (assert.is_truthy (string.find page "body{color:red}" 1 true))
                (assert.is_truthy (string.find page "console.log('hi')" 1 true))
                ;; Keep standards mode and put the harness before app code,
                ;; after the document metadata, exactly once.
                (assert.are.equal "<!doctype html>" (string.sub page 1 15))
                (let [harness-at (pick-values 1
                                               (string.find page
                                                            "window.__fenPreviewConsoleHarness"
                                                            1 true))
                      app-at (pick-values 1
                                          (string.find page "console.log('hi')" 1 true))]
                  (assert.is_true (> harness-at 15))
                  (assert.is_true (< harness-at app-at)))
                (assert.are.equal 1 (select 2 (string.gsub page "__fenPreviewConsoleHarness" "")))
                (assert.is_truthy (string.find page
                                                  "Object.defineProperty(window, 'console'"
                                                  1 true))
                (assert.is_truthy (string.find page "configurable: false" 1 true))
                ;; The host is the sole consumer; the harness must not keep a
                ;; second, dead entries ring in the iframe.
                (assert.is_nil (string.find page "entries.push" 1 true))
                ;; Re-entry calls the browser's true original, not the app's
                ;; replacement, and assigning the wrapper back is ignored.
                (assert.is_truthy (string.find page
                                                  "if (sending) return original.apply(consoleObject, arguments);"
                                                  1 true))
                (assert.is_truthy (string.find page "if (value === wrapped) return;" 1 true))
                (assert.is_truthy (string.find page
                                                  "if (sendingOnError) return trueOnError ? trueOnError.apply(this, arguments) : false;"
                                                  1 true))
                (assert.is_truthy (string.find page "if (value === onError) return;" 1 true))
                ;; the external references themselves are gone (inlined)
                (assert.is_nil (string.find page "href=\"style.css\"" 1 true))
                (assert.is_nil (string.find page "src=\"app.js\"" 1 true))))))

        (it "covers the exact console.log and window.onerror save-and-wrap idiom"
          (fn []
            (let [kv (make-kv)]
              (put-file kv "/index.html"
                        (.. "<!doctype html><script>"
                            "var orig = console.log; console.log = function(){ orig.apply(console, arguments); };"
                            "var onerrorOrig = window.onerror; window.onerror = function(){ return onerrorOrig.apply(this, arguments); };"
                            "</script>"))
              (let [(page _) (html.build-page kv "/index.html")]
                ;; These are the idioms the harness must survive, not a
                ;; different assignment shape that would miss the regression.
                (assert.is_truthy (string.find page
                                                  "var orig = console.log; console.log = function()"
                                                  1 true))
                (assert.is_truthy (string.find page
                                                  "var onerrorOrig = window.onerror; window.onerror = function()"
                                                  1 true))
                (assert.is_truthy (string.find page "sending = false" 1 true))
                (assert.is_truthy (string.find page "sendingOnError = false" 1 true))))))

        (it "keeps console capture after the exact delete-console.log attempt"
          (fn []
            (let [kv (make-kv)]
              (put-file kv "/index.html"
                        (.. "<!doctype html><script>"
                            "var deleteResult = delete console.log; console.log('after-delete');"
                            "</script>"))
              (let [(page _) (html.build-page kv "/index.html")]
                ;; The generated accessor is non-configurable, so delete is a
                ;; false/no-op in the app and the subsequent call still reaches
                ;; the wrapper; keep both exact operations in the fixture.
                (assert.is_truthy (string.find page "delete console.log" 1 true))
                (assert.is_truthy (string.find page "console.log('after-delete')" 1 true))
                (assert.is_truthy (string.find page "configurable: false" 1 true))))))

        (it "leaves absolute URL references untouched"
          (fn []
            (let [kv (make-kv)]
              (put-file kv "/index.html"
                        (.. "<link rel=\"stylesheet\" href=\"https://cdn/x.css\">"
                            "<script src=\"https://cdn/x.js\"></script>"))
              (let [(page _) (html.build-page kv "/index.html")]
                (assert.is_truthy (string.find page "https://cdn/x.css" 1 true))
                (assert.is_truthy (string.find page "https://cdn/x.js" 1 true))))))

        (it "SECURITY: never emits the API key stored outside the vfs"
          (fn []
            (let [kv (make-kv)]
              ;; The settings form stores the key under env/apikey/<VAR>, a key
              ;; space the vfs ("fs:") never walks.
              (kv.put "env/apikey/ANTHROPIC_API_KEY" "sk-ant-SECRET")
              (put-file kv "/index.html" "<body>hello</body>")
              (let [(page _) (html.build-page kv "/index.html")]
                (assert.is_nil (string.find page "sk-ant-SECRET" 1 true))
                (assert.is_nil (string.find page "SECRET" 1 true))))))))

    (describe "tool registration"
      (fn []
        (it "registers the seven preview.* tools; refresh+console :always, rest :search"
          (fn []
            (let [registered []
                  api {:register (fn [kind spec] (table.insert registered [kind spec]))}]
              (preview.register api)
              (assert.are.equal 7 (length registered))
              (let [names []]
                (each [_ [kind spec] (ipairs registered)]
                  (assert.are.equal :tool kind)
                  ;; preview_refresh (system-prompt entry point) and
                  ;; preview_console (debugging lifeline) are always-visible;
                  ;; the rest are tool_search-gated.
                  (assert.are.equal
                    (if (or (= spec.name :preview_refresh)
                            (= spec.name :preview_console))
                        :always
                        :search)
                    spec.exposure)
                  (table.insert names spec.name))
                (table.sort names)
                (assert.are.same
                  [:preview_click :preview_console :preview_eval :preview_fill
                   :preview_query :preview_refresh :preview_screenshot]
                  names)))))))

    (describe "refresh tool"
      (fn []
        (it "renders the vfs entry into host.preview via set-html"
          (fn []
            (let [kv (make-kv)
                  prev (make-preview)]
              (install-host! kv prev)
              (put-file kv "/index.html" "<body>app here</body>")
              (let [tool (do (var t nil)
                             (preview.register
                               {:register (fn [_ s] (when (= s.name :preview_refresh) (set t s)))})
                             t)
                    r (tool.execute {} {} nil)]
                (assert.is_false r.is-error?)
                (assert.is_truthy (string.find prev.html "app here" 1 true))
                ;; the injected page is what preview_refresh built (no RPC yet)
                (assert.are.equal 0 (length prev.requests))))))))

    (describe "RPC-backed tools"
      (fn []
        (fn tool-named [name responder]
          (let [prev (make-preview responder)]
            (install-host! (make-kv) prev)
            (var t nil)
            (preview.register
              {:register (fn [_ s] (when (= s.name name) (set t s)))})
            (values t prev)))

        (it "preview_query relays the selector and returns the JSON result"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_query
                              (fn [req] {:ok true :value {:count 1 :found true}}))
                  r (tool.execute {:selector "#app"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal :query (. prev.requests 1 :method))
              (assert.are.equal "#app" (. prev.requests 1 :selector))
              (assert.is_truthy (string.find (text-of r) "\"count\"" 1 true)))))

        (it "preview_click appends an uncaught-error marker when the buffer is non-empty"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_click
                              (fn [_req] {:ok true :value {:clicked true}}))]
              (table.insert prev.console {:level :error :args ["boom"] :uncaught true})
              (let [r (tool.execute {:selector "#x"} {} nil)]
                (assert.is_false r.is-error?)
                (assert.is_truthy (string.find (text-of r)
                                               "1 uncaught error since last check (use preview_console)"
                                               1 true))))))

        (it "preview_console drains entries and exposes error stacks"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_console (fn [_req] {:ok true}))]
              (table.insert prev.console
                            {:level :error :args ["boom"]
                             :stack "Error: boom\\n at app.js:1" :uncaught true})
              (let [first (tool.execute {} {} nil)
                    second (tool.execute {} {} nil)]
                (assert.is_false first.is-error?)
                (assert.is_truthy (string.find (text-of first) "boom" 1 true))
                (assert.is_truthy (string.find (text-of first) "app.js:1" 1 true))
                (assert.are.equal "[]" (text-of second))))))

        (it "does not send proxy-like userdata to cjson"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_console (fn [_req] {:ok true}))
                  proxy (io.tmpfile)]
              (assert.are.equal :userdata (type proxy))
              (set _G.__fen_host.preview_console_drain (fn [] proxy))
              (let [(ok? result) (pcall tool.execute {} {} nil)]
                (assert.is_true ok?)
                (assert.is_true result.is-error?)
                (assert.is_truthy (string.find (text-of result)
                                               "non-JSON data" 1 true))))))

        (it "preview_click reports an RPC failure as a tool error"
          (fn []
            (let [(tool _prev)
                  (tool-named :preview_click
                              (fn [_req] {:ok false :error "no element matches #x"}))
                  r (tool.execute {:selector "#x"} {} nil)]
              (assert.is_true r.is-error?)
              (assert.is_truthy (string.find (text-of r) "no element matches" 1 true)))))

        (it "preview_fill sends the selector and value"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_fill (fn [_req] {:ok true :value {:filled true}}))
                  r (tool.execute {:selector "#name" :value "ada"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal "{\"filled\":true}" (text-of r))
              (assert.are.equal "#name" (. prev.requests 1 :selector))
              (assert.are.equal "ada" (. prev.requests 1 :value)))))

        (it "preview_eval returns the serialized value"
          (fn []
            (let [(tool prev)
                  (tool-named :preview_eval (fn [_req] {:ok true :value 42}))
                  r (tool.execute {:expr "6*7"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal "6*7" (. prev.requests 1 :expr))
              (assert.is_truthy (string.find (text-of r) "42" 1 true)))))

        (it "preview_screenshot returns the canvas data URL string"
          (fn []
            (let [(tool _prev)
                  (tool-named :preview_screenshot
                              (fn [_req] {:ok true :value {:dataUrl "data:image/png;base64,AAA"}}))
                  r (tool.execute {} {} nil)]
              (assert.is_false r.is-error?)
              (assert.is_truthy (string.find (text-of r) "dataUrl" 1 true))
              (assert.is_truthy (string.find (text-of r) "png" 1 true)))))

        (it "errors clearly when an RPC can't complete without a cooperative yield"
          (fn []
            ;; A host.preview whose poll never reports done, and no yield-fn.
            (let [prev (make-preview)]
              (set prev.preview_rpc_poll (fn [_id] {:done false}))
              (install-host! (make-kv) prev)
              (var tool nil)
              (preview.register
                {:register (fn [_ s] (when (= s.name :preview_query) (set tool s)))})
              (let [(ok? err) (pcall tool.execute {:selector "#x"} {} nil)]
                (assert.is_false ok?)
                (assert.is_truthy (string.find (tostring err) "cooperative" 1 true))))))

        (it "times out (structured error + dispose) when the preview never replies"
          (fn []
            ;; A preview whose poll never reports done \u2014 e.g. a blank iframe
            ;; driven before preview_refresh. With a yield-fn present, the loop
            ;; must not spin forever: the Fennel-side liveness bound disposes
            ;; and returns a structured {:ok false :error ...} rather than
            ;; hanging the turn coroutine.
            (let [prev (make-preview)
                  disposed []]
              (set prev.preview_rpc_poll (fn [_id] {:done false}))
              (set prev.preview_rpc_dispose
                   (fn [id] (table.insert disposed id)))
              (install-host! (make-kv) prev)
              (var yields 0)
              (let [r (preview.rpc! {:method :query :selector "#x"}
                                    (fn [] (set yields (+ yields 1)))
                                    {:max-polls 3})]
                (assert.is_false r.ok)
                (assert.is_truthy (string.find r.error "timed out" 1 true))
                (assert.is_truthy (string.find r.error "preview_refresh" 1 true))
                ;; bounded: it yielded a few times then gave up, and cleaned up.
                (assert.is_true (<= yields 3))
                (assert.are.equal 1 (length disposed))))))

        (it "surfaces the RPC timeout as a structured tool error (not a throw)"
          (fn []
            ;; The tool wrapper must turn the timeout into a tool error, the
            ;; same shape a real RPC failure produces \u2014 never an uncaught throw.
            (let [prev (make-preview)]
              (set prev.preview_rpc_poll (fn [_id] {:done false}))
              (install-host! (make-kv) prev)
              (var tool nil)
              (preview.register
                {:register (fn [_ s] (when (= s.name :preview_query) (set tool s)))})
              ;; Drive M.rpc! straight to the timeout branch by exhausting the
              ;; poll ceiling on the very first poll.
              (let [orig preview.rpc!]
                (set preview.rpc!
                     (fn [req yield _opts] (orig req yield {:max-polls 1})))
                (let [(ok? r) (pcall tool.execute {:selector "#x"}
                                     {} (fn [] nil))]
                  (set preview.rpc! orig)
                  (assert.is_true ok?)
                  (assert.is_true r.is-error?)
                  (assert.is_truthy (string.find (text-of r) "timed out" 1 true)))))))))))
