;; fen.core.llm.models API-key lookup precedence over the kv-backed io/os
;; shim (fen_web.shims.fs-kv), per fen-web#15. This is the seam issue #7's
;; BYO-key storage plugs into: writing kv["env/apikey/<VAR>"] is exactly
;; what setting an API key through the UI will do once #7 lands.

(local support (require :support))
(local fs-kv (require :fen_web.shims.fs_kv))

(describe "fen.core.llm.models API-key resolution over fs-kv"
  (fn []
    (var snap nil)
    (var kv nil)
    (var models nil)

    (before_each
      (fn []
        (set snap (fs-kv.snapshot-globals))
        (set kv (support.make-kv))
        ;; Require against the real filesystem first (Busted's Fennel
        ;; searcher itself uses io.open to read .fnl sources from disk),
        ;; then install the kv shim so models.fnl's own os.getenv/io.open
        ;; calls at runtime hit the test kv -- see settings_test.fnl for
        ;; the same ordering rationale. models.fnl also caches its
        ;; providers-map and dynamic-model results in module-level
        ;; upvalues, so a fresh require per test resets that state too.
        (each [name _ (pairs package.loaded)]
          (when (string.match name "^fen%.core%.llm%.models")
            (tset package.loaded name nil)))
        (set models (require :fen.core.llm.models))
        (fs-kv.install! kv)))

    (after_each
      (fn []
        (fs-kv.uninstall! snap)
        (each [name _ (pairs package.loaded)]
          (when (string.match name "^fen%.core%.llm%.models")
            (tset package.loaded name nil)))))

    (it "treats an all-caps apiKey value as an env-var name"
      (fn []
        (assert.is_true (models.looks-like-env-var? "OPENAI_API_KEY"))
        (assert.is_false (models.looks-like-env-var? "sk-literal-value"))))

    (it "literal apiKey values win: no kv/env lookup happens"
      (fn []
        (assert.are.equal "sk-literal-value"
                           (models.resolve-api-key "sk-literal-value"))))

    (it "env-var-name apiKey resolves through the kv-backed, allowlisted os.getenv"
      (fn []
        (kv.put "env/apikey/OPENAI_API_KEY" "sk-from-kv")
        (assert.are.equal "sk-from-kv"
                           (models.resolve-api-key "OPENAI_API_KEY"))))

    (it "env-var-name apiKey resolves to nil when the kv key is unset (precedence: unset env beats nothing, not a stale value)"
      (fn []
        (assert.is_nil (models.resolve-api-key "OPENAI_API_KEY"))))

    (it "blank/nil apiKey values resolve to nil without touching kv"
      (fn []
        (assert.is_nil (models.resolve-api-key nil))
        (assert.is_nil (models.resolve-api-key ""))))

    (it "a non-API-key-shaped all-caps value (e.g. a debug flag name) never resolves, even if kv has a stray write under it"
      (fn []
        ;; Writing directly under the old unnamespaced "env/<NAME>" key
        ;; (or anything not shaped like an API key var) must not leak
        ;; through -- resolve-api-key treats any all-caps value as an
        ;; env-var name to look up, so this is the models.fnl-facing half
        ;; of the getenv allowlist check in fs_kv_test.fnl.
        (kv.put "env/apikey/FEN_LOG" "debug")
        (assert.is_nil (models.resolve-api-key "FEN_LOG"))))

    (it "get-provider reads models.json through the kv-backed io.open and resolves apiKey"
      (fn []
        (kv.put "env/apikey/ANTHROPIC_API_KEY" "sk-from-kv-provider")
        (kv.put (models.config-path)
                "{\"providers\":{\"custom\":{\"api\":\"anthropic\",\"apiKey\":\"ANTHROPIC_API_KEY\",\"models\":[{\"id\":\"m1\"}]}}}")
        (let [provider (models.get-provider :custom)]
          (assert.are.equal "anthropic" provider.api)
          (assert.are.equal "sk-from-kv-provider" provider.api-key)
          (assert.are.equal "ANTHROPIC_API_KEY" provider.api-key-var))))

    (it "get-provider returns nil for a provider absent from models.json"
      (fn []
        (kv.put (models.config-path) "{\"providers\":{}}")
        (assert.is_nil (models.get-provider :missing))))))
