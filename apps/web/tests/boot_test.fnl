;; Reload contract for the manifest-driven browser tool extension. This uses
;; the real web boot loader and registry, but stubs only the provider module
;; that boot requires at module load; no network or DOM host is needed to
;; exercise registration/reload.

(local register (require :fen.core.extensions.register))
(local support (require :support))
(local state (require :fen_web.web.state))
(local ingest (require :fen_web.web.ingest))
(local layout (require :fen_web.web.layout))

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

    (it "parses slash commands but leaves normal messages alone"
      (fn []
        (let [new-command (boot.parse-command "/new")
              sessions-command (boot.parse-command "/sessions list")
              help-command (boot.parse-command "/help")
              unknown-command (boot.parse-command "/unknown arg")
              forwarded {}
              _ (boot.submit-line!
                  {:submit-user-turn!
                   (fn [line opts]
                     (set forwarded.line line)
                     (set forwarded.opts opts)
                     :normal-result)}
                  "normal message")]
          (assert.are.equal "new" new-command.name)
          (assert.are.equal "" new-command.args)
          (assert.are.equal "sessions" sessions-command.name)
          (assert.are.equal "list" sessions-command.args)
          (assert.are.equal "help" help-command.name)
          (assert.are.equal "unknown" unknown-command.name)
          (assert.are.equal "arg" unknown-command.args)
          (assert.is_nil (boot.parse-command "normal message"))
          (assert.are.equal "normal message" forwarded.line)
          (assert.is_true forwarded.opts.emit-user?))))

    (it "resumes the seeded latest session and hydrates its messages for rendering"
      (fn []
        (support.reset-state!)
        (let [calls {}
              seeded {:id "seeded-session" :cwd "/workspace"}
              messages [{:role :user :content "remember this"}
                        {:role :assistant :content [{:type :text
                                                      :text "I remember"}]}]
              backend {:latest (fn [cwd]
                                 (set calls.cwd cwd)
                                 "seeded-session")
                       :load (fn [id]
                               (set calls.loaded id)
                               messages)
                       :open-existing (fn [id]
                                        (set calls.opened id)
                                        seeded)
                       :open (fn [_] (error "resume should not open a new session"))}
              opened (boot.open-or-resume-session backend "/workspace")]
          (assert.are.equal "/workspace" calls.cwd)
          (assert.are.equal "seeded-session" calls.loaded)
          (assert.are.equal "seeded-session" calls.opened)
          (assert.is_true opened.resumed?)
          (assert.are.equal seeded opened.session)
          (assert.are.same messages opened.messages)
          (ingest.hydrate! opened.messages)
          (let [rows (icollect [_ event (ipairs state.transcript)]
                        (layout.transcript-row event))]
            (assert.are.equal 2 (length rows))
            (assert.are.equal "> remember this" (. rows 1 :text))
            (assert.are.equal "I remember" (. rows 2 :text))))))

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
