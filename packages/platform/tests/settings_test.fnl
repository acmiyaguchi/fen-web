;; fen.core.settings through fen v0.17's injected storage backend seam.
;; The browser runtime fulfills fen.core.storage.backend directly; no global
;; io/os patch is involved in this test.

(local support (require :support))

(describe "fen.core.settings over storage backend"
  (fn []
    (var kv nil)
    (var settings nil)

    (before_each
      (fn []
        (set kv (support.make-kv))
        (support.install-kv-seams! kv)
        (tset package.loaded :fen.core.settings nil)
        ;; Require the real fen module after the backend preload is installed.
        ;; Its source still comes from Busted's real filesystem searcher, but
        ;; the module's storage calls resolve through the injected backend.
        (set settings (require :fen.core.settings))))

    (after_each
      (fn []
        (tset package.loaded :fen.core.settings nil)
        (support.clear-kv-seams!)))

    (it "loads an empty record when nothing has been saved"
      (fn []
        (let [s (settings.load)]
          (assert.is_nil s.default-provider)
          (assert.is_nil s.default-model))))

    (it "round-trips default provider/model through save!/load"
      (fn []
        (settings.set-defaults! :anthropic :claude-sonnet)
        (let [s (settings.load)]
          (assert.are.equal :anthropic s.default-provider)
          (assert.are.equal :claude-sonnet s.default-model))))

    (it "persists the write via the injected storage backend"
      (fn []
        (settings.set-defaults! :anthropic :claude-sonnet)
        (let [raw (kv.get (settings.config-path))]
          (assert.is_not_nil raw)
          (assert.truthy (string.find raw "anthropic")))))

    (it "adopt-default-if-unset! only writes when nothing is set yet"
      (fn []
        (let [wrote-first? (settings.adopt-default-if-unset! :openai :gpt)
              wrote-second? (settings.adopt-default-if-unset! :anthropic :claude)]
          (assert.is_true wrote-first?)
          (assert.is_false wrote-second?)
          (assert.are.equal :openai (. (settings.load) :default-provider)))))

    (it "removing the underlying storage value makes settings load empty again"
      (fn []
        (settings.set-defaults! :anthropic :claude-sonnet)
        (kv.delete (settings.config-path))
        (let [s (settings.load)]
          (assert.is_nil s.default-provider))))

    (it "set-thinking-default! persists independently of provider/model"
      (fn []
        (settings.set-thinking-default! :high)
        (assert.are.equal :high (. (settings.load) :default-thinking))))))
