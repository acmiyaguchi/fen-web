;; Tests for the sandboxed-iframe preview extension (fen-web#8): the vfs->HTML
;; page assembler, the demo-only preview.* tool registration, and each tool's
;; behavior over a table-backed host.preview double (the Fennel stand-in for
;; packages/bindings/src/preview/fakePreview.ts — the Busted harness has no TS
;; runtime, mirroring the host.dom-apply fake in support.fnl).
;;
;; Security-invariant coverage: the no-leak spec asserts build-page emits ONLY
;; vfs content and never the API key stored under env/apikey/<VAR>.

(local support (require :support))
(local html (require :fen_web.demo.preview.html))
(local preview (require :fen_web.demo.preview))

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
         (fn [id] {:done true :result (. h.results id)}))
    (set h.preview_rpc_dispose (fn [id] (tset h.results id nil)))
    h))

(fn install-host! [kv prev]
  (let [host {}]
    (when kv (set host.kv kv))
    (when prev
      (set host.preview_set_html prev.preview_set_html)
      (set host.preview_rpc_start prev.preview_rpc_start)
      (set host.preview_rpc_poll prev.preview_rpc_poll)
      (set host.preview_rpc_dispose prev.preview_rpc_dispose))
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

        (it "inlines same-tree stylesheet and script references from the vfs"
          (fn []
            (let [kv (make-kv)]
              (put-file kv "/index.html"
                        (.. "<html><head>"
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
                ;; the external references themselves are gone (inlined)
                (assert.is_nil (string.find page "href=\"style.css\"" 1 true))
                (assert.is_nil (string.find page "src=\"app.js\"" 1 true))))))

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
        (it "registers the six preview.* tools with :always exposure"
          (fn []
            (let [registered []
                  api {:register (fn [kind spec] (table.insert registered [kind spec]))}]
              (preview.register api)
              (assert.are.equal 6 (length registered))
              (let [names []]
                (each [_ [kind spec] (ipairs registered)]
                  (assert.are.equal :tool kind)
                  (assert.are.equal :always spec.exposure)
                  (table.insert names spec.name))
                (table.sort names)
                (assert.are.same
                  [:preview.click :preview.eval :preview.fill
                   :preview.query :preview.refresh :preview.screenshot]
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
                               {:register (fn [_ s] (when (= s.name :preview.refresh) (set t s)))})
                             t)
                    r (tool.execute {} {} nil)]
                (assert.is_false r.is-error?)
                (assert.is_truthy (string.find prev.html "app here" 1 true))
                ;; the injected page is what preview.refresh built (no RPC yet)
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

        (it "preview.query relays the selector and returns the JSON result"
          (fn []
            (let [(tool prev)
                  (tool-named :preview.query
                              (fn [req] {:ok true :value {:count 1 :found true}}))
                  r (tool.execute {:selector "#app"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal :query (. prev.requests 1 :method))
              (assert.are.equal "#app" (. prev.requests 1 :selector))
              (assert.is_truthy (string.find (text-of r) "\"count\"" 1 true)))))

        (it "preview.click reports an RPC failure as a tool error"
          (fn []
            (let [(tool _prev)
                  (tool-named :preview.click
                              (fn [_req] {:ok false :error "no element matches #x"}))
                  r (tool.execute {:selector "#x"} {} nil)]
              (assert.is_true r.is-error?)
              (assert.is_truthy (string.find (text-of r) "no element matches" 1 true)))))

        (it "preview.fill sends the selector and value"
          (fn []
            (let [(tool prev)
                  (tool-named :preview.fill (fn [_req] {:ok true :value {:filled true}}))
                  r (tool.execute {:selector "#name" :value "ada"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal "#name" (. prev.requests 1 :selector))
              (assert.are.equal "ada" (. prev.requests 1 :value)))))

        (it "preview.eval returns the serialized value"
          (fn []
            (let [(tool prev)
                  (tool-named :preview.eval (fn [_req] {:ok true :value 42}))
                  r (tool.execute {:expr "6*7"} {} nil)]
              (assert.is_false r.is-error?)
              (assert.are.equal "6*7" (. prev.requests 1 :expr))
              (assert.is_truthy (string.find (text-of r) "42" 1 true)))))

        (it "preview.screenshot returns the canvas data URL string"
          (fn []
            (let [(tool _prev)
                  (tool-named :preview.screenshot
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
                {:register (fn [_ s] (when (= s.name :preview.query) (set tool s)))})
              (let [(ok? err) (pcall tool.execute {:selector "#x"} {} nil)]
                (assert.is_false ok?)
                (assert.is_truthy (string.find (tostring err) "cooperative" 1 true))))))))))
