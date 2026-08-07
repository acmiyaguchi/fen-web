;; Reload contract for the manifest-driven browser tool extension. This uses
;; the real web boot loader and registry, but stubs only the provider module
;; that boot requires at module load; no network or DOM host is needed to
;; exercise registration/reload.

(local register (require :fen.core.extensions.register))

(tset package.loaded "fen.util.clock.backend"
      {:monotonic-ms (fn [] 0)
       :sleep-ms (fn [_] nil)})

(tset package.preload "fen.extensions.provider_anthropic.anthropic_messages"
      (fn [] {:name :anthropic
              :complete (fn [] nil)}))
(tset package.preload "fen.extensions.provider_openai.openai_completions"
      (fn [] {:api :openai-completions
              :provider :openai
              :complete (fn [] nil)}))
(local boot (require :fen_web.web.boot))

(fn tool-set []
  (let [names {}
        exposures {}]
    (each [_ info (ipairs (register.list :tools))]
      (when (= (tostring info.owner) "fen_web_tools")
        (tset names (tostring info.name) true)
        (tset exposures (tostring info.name) info.exposure)))
    (values names exposures)))

(describe "fen-web manifest reload"
  (fn []
    (after_each
      (fn []
        (register.unregister-by-owner "fen_web_tools")
        (tset package.preload "fen.extensions.provider_anthropic.anthropic_messages" nil)
        (tset package.preload "fen.extensions.provider_openai.openai_completions" nil)))

    (it "uses an explicit model and provider fallback in boot options"
      (fn []
        (assert.are.equal "claude-sonnet-5"
                          (boot.model-for {:provider "anthropic"
                                           :model "claude-sonnet-5"}))
        (assert.are.equal "claude-haiku-4-5"
                          (boot.model-for {:provider "anthropic"}))
        (assert.are.equal "gpt-5.6-luna"
                          (boot.model-for {:provider "openai-codex"}))
        (assert.are.equal "gpt-5.4-nano"
                          (boot.model-for {:provider "openai"}))
        (assert.are.equal "anthropic/claude-haiku-4.5"
                          (boot.model-for {:provider "openrouter"}))
        (assert.is_true (boot.supported-provider? "openrouter"))
        (let [spec (boot.provider-spec-for "openrouter")]
          (assert.are.equal :openrouter spec.name)
          (assert.are.equal :OPENROUTER_API_KEY spec.api-key-var)
          (assert.are.equal "https://openrouter.ai/api/v1" spec.base-url)
          (assert.are.equal :openai-completions spec.api)
          ;; The provider-options compat seam is materialized in M.run; the
          ;; registry spec still exposes only metadata and adapter behavior.
          (assert.is_true (boot.supported-provider? "openai")))))

    (it "preserves the registered set and last register opts across reload"
      (fn []
        (boot.load-extension! :fen_web.tools.manifest false
                               {:enable-web-fetch true})
        (let [(before before-exposures) (tool-set)]
          (assert.is_true (. before "web_fetch"))
          (assert.are.equal :search (. before-exposures "web_fetch"))
          (boot.reload-extension! :fen_web.tools.manifest)
          (let [(after after-exposures) (tool-set)]
            (assert.are.same before after)
            (assert.are.equal :search (. after-exposures "web_fetch"))))))))
