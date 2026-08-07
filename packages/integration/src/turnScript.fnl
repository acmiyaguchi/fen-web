;; Orchestration script for the fen-web#5 headless-turn integration test.
;;
;; Runs entirely inside the Lua coroutine createCoroutinePump drives (see
;; packages/runtime/docs/runtime/boot.md's coroutine pump pattern): all of
;; fen's real extension-registration + agent-construction + step() calls
;; happen here, in Fennel, so the only JS/Lua boundary crossings are the
;; __fen_host primitives (kv get/put/delete/list, fetch_start/poll/dispose)
;; that fen-web's bindings/runtime packages already own. This mirrors how a
;; production caller would drive fen.core.agent directly (fen#175's formal
;; headless agent API isn't implemented yet, per fen-web#5's issue text).
;;
;; Not a fen-web platform module: lives in packages/integration/src (a test
;; fixture loaded through the same custom source-map searcher as everything
;; else), not under packages/platform/fnl, since it is test wiring, not a
;; reusable shim.

(local api-factory (require :fen.core.extensions.loader.api))
(local sessions-init (require :fen_web.sessions))
(local tools-init (require :fen_web.tools))
(local openai-completions (require :fen.extensions.provider_openai.openai_completions))
(local session-backend-registry (require :fen.core.extensions.register.session_backend))
(local agent-mod (require :fen.core.agent))

;; Registered directly against `openai_completions` (not
;; fen.extensions.provider_openai's own init.fnl/M.register), which also
;; pulls in the Codex OAuth/keychain modules this test has no use for --
;; see turn.test.ts's buildSources() for why only openai_completions.fnl
;; and its openai_model_catalog dependency are in the source map. Mirrors
;; init.fnl's own api-key-provider-spec shape (:name/:default-model/
;; :api-key-var merged over the provider record).
(fn openai-provider-spec []
  (let [spec {}]
    (each [k v (pairs openai-completions)] (tset spec k v))
    (set spec.name :openai)
    (set spec.default-model :gpt-5.4-nano)
    (set spec.api-key-var :OPENAI_API_KEY)
    spec))

;; @doc test.turn-script.run
;; kind: function
;; signature: (run opts) -> table
;; summary: Register providers/tools/session backend, build one agent, run step() for each scripted user message, and report events + replies.
;; tags: test integration headless-turn
(fn run [opts]
  (let [kv (. _G.__fen_host :kv)
        api (api-factory.make-api :fen-web-integration-test nil {:privileged? true})
        _reg-provider (api.register :provider (openai-provider-spec))
        ;; Keep registration defensively pcall'd: tool registration is not
        ;; load-bearing for this headless-turn fixture, while the returned
        ;; registry snapshot and turn.test.ts assertions still make failures
        ;; visible without masking them in the provider turn.
        (tools-ok? tools-err) (pcall tools-init.register api)
        registered-tools (icollect [_ info (ipairs (api.list :tools))] info.name)
        _reg-session (sessions-init.register api)
        _active (session-backend-registry.set-active! :kv)
        backend (session-backend-registry.find :kv)
        session (backend.open (or opts.cwd "/fen-web-test"))
        events []
        agent (agent-mod.make-agent
                {:provider-name :openai
                 :model (or opts.model "gpt-5.4-nano")
                 :system (or opts.system "You are a test assistant.")
                 :api-key "test-api-key"
                 :max-tokens 1024
                 :on-event (fn [ev] (table.insert events (or ev.type "?")))})
        replies []]
    (each [_ text (ipairs opts.messages)]
      (let [reply (agent-mod.step agent text)]
        (table.insert replies reply)))
    ;; Mirror fen.session_lifecycle.make-flush's persistence policy (fen-web
    ;; drives fen.core.agent directly for now, per fen-web#5's issue text,
    ;; rather than pulling in the whole interactive.fnl presenter loop): once
    ;; at least one assistant message exists, append every agent message to
    ;; the session backend in order.
    (each [_ m (ipairs agent.messages)]
      (backend.append session m))
    (backend.close session)
    {:replies replies
     :events events
     :session-id session.id
     :message-count (length agent.messages)
     :tools-registered? tools-ok?
     :tools-register-error (if tools-ok? nil (tostring tools-err))
     :registered-tool-names registered-tools}))

{: run}
