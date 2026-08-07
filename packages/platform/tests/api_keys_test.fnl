;; fen.core.llm.models API-key resolution through fen v0.17's path.getenv
;; seam and storage backend seam. The browser runtime supplies both directly;
;; this test no longer installs fs_kv globals.

(local support (require :support))

(describe "fen.core.llm.models API-key resolution over v0.17 seams"
  (fn []
    (var kv nil)
    (var models nil)

    (before_each
      (fn []
        (set kv (support.make-kv))
        (support.install-kv-seams! kv)
        ;; models.fnl caches its providers map and dynamic model results in
        ;; module-level state, so a fresh require per test resets that state.
        (each [name _ (pairs package.loaded)]
          (when (string.match name "^fen%.core%.llm%.models")
            (tset package.loaded name nil)))
        (set models (require :fen.core.llm.models))))

    (after_each
      (fn []
        (each [name _ (pairs package.loaded)]
          (when (string.match name "^fen%.core%.llm%.models")
            (tset package.loaded name nil)))
        (support.clear-kv-seams!)))

    (it "treats an all-caps apiKey value as an env-var name"
      (fn []
        (assert.is_true (models.looks-like-env-var? "OPENAI_API_KEY"))
        (assert.is_false (models.looks-like-env-var? "sk-literal-value"))))

    (it "literal apiKey values win: no kv/env lookup happens"
      (fn []
        (assert.are.equal "sk-literal-value"
                           (models.resolve-api-key "sk-literal-value"))))

    (it "env-var-name apiKey resolves through path.getenv and the kv backend"
      (fn []
        (kv.put "env/apikey/OPENAI_API_KEY" "sk-from-kv")
        (assert.are.equal "sk-from-kv"
                           (models.resolve-api-key "OPENAI_API_KEY"))))

    (it "env-var-name apiKey resolves to nil when the kv key is unset"
      (fn []
        (assert.is_nil (models.resolve-api-key "OPENAI_API_KEY"))))

    (it "blank/nil apiKey values resolve to nil without touching kv"
      (fn []
        (assert.is_nil (models.resolve-api-key nil))
        (assert.is_nil (models.resolve-api-key ""))))

    (it "a non-API-key-shaped all-caps value never resolves"
      (fn []
        (kv.put "env/apikey/FEN_LOG" "debug")
        (assert.is_nil (models.resolve-api-key "FEN_LOG"))))

    (it "get-provider reads models.json through storage and resolves apiKey"
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
