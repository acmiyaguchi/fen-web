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
          ;; A lone "/" (or whitespace-only body) is not a command.
          (assert.is_nil (boot.parse-command "/"))
          (assert.is_nil (boot.parse-command "/   "))
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

    (it "redacts agent-state values before they reach a truncation boundary"
      (fn []
        (let [secret "sk-ant-api03-test-secret-material"
              surface (boot.redact-surface
                        {:api-key secret
                         :api-key-var "ANTHROPIC_API_KEY"
                         :message (.. "prefix " secret " suffix")}
                        [secret])]
          (assert.are.equal "[redacted]" (. surface "api-key"))
          (assert.are.equal "ANTHROPIC_API_KEY" (. surface "api-key-var"))
          (assert.are.equal "prefix [redacted] suffix" surface.message))))

    (it "unit-tests web agent-state redaction helpers"
      (fn []
        (let [secret "sk-ant-api03-test-secret-material"
              short "oops"
              kv {:list (fn [_] ["env/apikey/ANTHROPIC_API_KEY"
                                 "env/apikey/SHORT"])
                  :get (fn [key]
                         (if (= key "env/apikey/ANTHROPIC_API_KEY") secret
                             (= key "env/apikey/SHORT") short
                             nil))}
              secrets (boot.credential-secrets kv short)]
          (assert.are.equal "before[redacted]after"
                            (boot.replace-secret (.. "before" secret "after") secret))
          (assert.are.equal "[redacted]"
                            (boot.redact-string secret [secret]))
          (assert.are.equal "[redacted]"
                            (boot.redact-string
                              "sk-ant-api03-test-secret-material" []))
          (assert.is_nil (boot.redact-string nil [secret]))
          (assert.is_true (boot.credential-field? "api-key"))
          (assert.is_true (boot.credential-field? "authorization"))
          (assert.is_false (boot.credential-field? "api-key-var"))
          (assert.is_false (boot.credential-field? "model-var"))
          (assert.is_true (boot.credential-field? "token"))
          (assert.are.equal 1 (length secrets))
          (assert.are.equal secret (. secrets 1)))))

    (it "decorates agent-state registration with pre-truncation redaction"
      (fn []
        (let [secret "sk-ant-api03-test-secret-material"
              captured {}
              api {:models {:list (fn [_] [{:api-key secret
                                             :api-key-var "ANTHROPIC_API_KEY"}])
                            :inspect (fn [_ _] [])
                            :dynamic-cache (fn [] {:secret secret})
                            :resolve (fn [_ _]
                                       {:status :ok
                                        :model {:provider "fake"
                                                :id "model"
                                                :api-key secret}})
                            :canonical-id (fn [_] (.. "fake/" secret))}
                   :session {:info (fn [] {})
                             :active-backend (fn [] {:name "kv"
                                                     :secret secret})}
                   :diagnostics {:list-errors (fn [] [])
                                 :error-log-path (fn [] "/tmp/errors")}
                   :introspect {:collect (fn [_ _] {})}
                   :list (fn [_] [{:api-key secret}])
                   :register (fn [_ spec] (set captured.spec spec))}
              safe (boot.safe-agent-state-api api [secret])]
          (safe.register :tool
            {:name :agent_state
             :execute (fn [args ctx _yield]
                        (let [text (?. ctx :agent :messages 1 :content)]
                          {:content [{:text (string.sub text 1 args.max_bytes)}]
                           :is-error? false}))})
          (let [result (captured.spec.execute
                         {:query "(:get :messages)" :max_bytes 5}
                         {:agent {:messages [{:role :user :content secret}]}}
                         nil)]
            (assert.is_false result.is-error?)
            ;; The fake companion truncates inside execute. Seeing the
            ;; replacement prefix proves the wrapper redacted the context
            ;; before that cut, rather than merely replacing a full secret in
            ;; the returned result.
            (assert.are.equal "[reda" (. result.content 1 :text)))
          (assert.are.equal "[redacted]"
                            (. (safe.models.dynamic-cache) :secret))
          (assert.are.equal "[redacted]"
                            (. (safe.session.active-backend) :secret))
          (assert.are.equal "fake/[redacted]"
                            (safe.models.canonical-id {:provider "fake" :id secret})))))

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
