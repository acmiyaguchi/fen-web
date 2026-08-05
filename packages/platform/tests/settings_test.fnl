;; fen.core.settings round-trip against the kv-backed io/os shim
;; (fen_web.shims.fs-kv), per fen-web#15.

(local support (require :support))
(local fs-kv (require :fen_web.shims.fs_kv))

(describe "fen.core.settings over fs-kv"
  (fn []
    (var snap nil)
    (var kv nil)
    (var settings nil)

    (before_each
      (fn []
        (set snap (fs-kv.snapshot-globals))
        (set kv (support.make-kv))
        ;; settings.fnl is a plain (not reloadable-cached) module -- fresh
        ;; require each time so no cross-test module-level state leaks. The
        ;; (re)require must happen against the *real* io.open, before
        ;; fs-kv.install! -- Busted's Fennel searcher reads the .fnl source
        ;; itself off disk via io.open, so installing the kv shim first
        ;; would make module loading try to fetch settings.fnl's own
        ;; source out of the (empty) test kv instead of the filesystem.
        (tset package.loaded :fen.core.settings nil)
        (set settings (require :fen.core.settings))
        (fs-kv.install! kv)))

    (after_each
      (fn []
        (fs-kv.uninstall! snap)
        (tset package.loaded :fen.core.settings nil)))

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

    (it "persists the write via the kv store, not just in-process state"
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

    (it "removing the underlying key (os.remove) makes settings load empty again"
      (fn []
        (settings.set-defaults! :anthropic :claude-sonnet)
        (os.remove (settings.config-path))
        (let [s (settings.load)]
          (assert.is_nil s.default-provider))))

    (it "set-thinking-default! persists independently of provider/model"
      (fn []
        (settings.set-thinking-default! :high)
        (assert.are.equal :high (. (settings.load) :default-thinking))))))
