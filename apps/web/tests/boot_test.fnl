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
        (tset package.preload "fen.extensions.provider_anthropic.anthropic_messages" nil)))

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
