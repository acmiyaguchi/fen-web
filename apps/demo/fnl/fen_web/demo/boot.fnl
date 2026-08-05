;; Browser boot orchestration for the fen-web demo (fen-web#7).
;;
;; This is the single-page app's Fennel entry point: it registers the
;; providers/tools/session backend/DOM presenter against fen's real
;; extension api, builds one agent, and drives the active presenter's turn
;; loop — the browser analog of a fen interactive session
;; (fen/packages/fen/src/fen/interactive.fnl's `run!`), scoped down to what
;; the page needs. It runs inside the coroutine pump the HTML shell drives
;; (packages/runtime createCoroutinePump; see docs/runtime/boot.md), so the
;; only JS/Lua boundary crossings are the __fen_host primitives (kv, fetch,
;; dom-apply) fen-web's bindings own.
;;
;; It deliberately does NOT reuse fen's CLI-shaped run! wholesale: that pulls
;; arg parsing, the extension loader's manifest discovery, steering queues,
;; termbox2 teardown, and os.exit process control — none of which apply
;; in-page. Instead it wires the same pieces fen's presenter contract needs
;; (on-submit/on-tick/is-busy?/request-cancel) directly, the same way
;; packages/integration/src/turnScript.fnl mirrors fen's persistence policy
;; for the headless-turn test rather than importing the whole loop.
;;
;; The turn coroutine uses fen.util.coroutines.create (fen's own cooperative
;; coroutine constructor) so agent.step auto-detects cooperative mode and
;; yields between phases; on-tick resumes it once per rendered frame, exactly
;; as interactive.fnl's on-tick resumes state.turn.

(local api-factory (require :fen.core.extensions.loader.api))
(local fs-kv (require :fen_web.shims.fs_kv))
(local sessions-init (require :fen_web.sessions))
(local tools-init (require :fen_web.tools))
(local demo (require :fen_web.demo))
(local anthropic (require :fen.extensions.provider_anthropic.anthropic_messages))
(local session-backend-registry
       (require :fen.core.extensions.register.session_backend))
(local tool-registry (require :fen.core.extensions.register.tool))
(local presenter-registry (require :fen.core.extensions.register.presenter))
(local agent-mod (require :fen.core.agent))
(local coroutines (require :fen.util.coroutines))
(local events (require :fen.core.extensions.events))
(local token-util (require :fen.util.tokens))
(local first-line (. (require :fen.util.text) :first-line))

(local M {})

(local DEFAULT-SYSTEM
  (.. "You are fen, a coding agent running entirely in the user's browser. "
      "The workspace is a virtual filesystem backed by IndexedDB; use the "
      "read/write/edit/find/grep/ls tools to work in it. Be concise."))

;; Provider order per docs/apps/demo.md: Anthropic first because
;; api.anthropic.com accepts direct-from-page calls (the fen-web fetch
;; backend adds the required anthropic-dangerous-direct-browser-access
;; header for that host; see packages/bindings/fnl/.../fetch.fnl). Mirrors
;; fen's anthropic init.fnl provider-spec shape (:name/:default-model/
;; :api-key-var merged over the provider record) so registration is
;; identical to the desktop provider.
(fn anthropic-provider-spec []
  (let [spec {}]
    (each [k v (pairs anthropic)] (tset spec k v))
    (set spec.name :anthropic)
    (set spec.default-model :claude-haiku-4-5)
    (set spec.api-key-var :ANTHROPIC_API_KEY)
    spec))

(fn trim [s]
  (let [(out _) (string.gsub (tostring (or s "")) "^%s*(.-)%s*$" "%1")]
    out))

(fn assistant-present? [messages]
  (var found? false)
  (each [_ m (ipairs (or messages []))]
    (when (= m.role :assistant) (set found? true)))
  found?)

;; @doc fen_web.demo.boot.make-state
;; kind: function
;; signature: (make-state agent session backend) -> table
;; summary: Build the mutable run-state the presenter turn loop mutates (agent, session, busy/turn/cancel flags, persistence cursor), mirroring the fields fen.run_state.make owns for the interactive loop.
;; tags: demo boot state turn
(fn M.make-state [agent session backend]
  {:agent agent :session session :backend backend
   :busy? false :turn nil :cancel-requested? false :last-saved 0})

;; @doc fen_web.demo.boot.flush!
;; kind: function
;; signature: (flush! state) -> nil
;; summary: Append agent messages added since the last flush to the session backend once an assistant message exists, mirroring fen.session_lifecycle.make-flush's hold-until-assistant policy.
;; tags: demo boot sessions persistence
(fn M.flush! [state]
  (when (and state.backend state.session
             (assistant-present? state.agent.messages))
    (while (< state.last-saved (length state.agent.messages))
      (set state.last-saved (+ state.last-saved 1))
      (state.backend.append state.session
                            (. state.agent.messages state.last-saved)))))

;; @doc fen_web.demo.boot.start-turn!
;; kind: function
;; signature: (start-turn! state text) -> nil
;; summary: Begin one user turn: create a cooperative agent.step coroutine (so it yields between provider/tool phases) and mark the run-state busy. No-op while a turn is already running.
;; tags: demo boot turn coroutine
(fn M.start-turn! [state text]
  (when (and (not state.busy?) (not= (trim text) ""))
    (events.emit {:type :user :text text})
    (set state.cancel-requested? false)
    (set state.turn
         (coroutines.create
           (fn []
             (agent-mod.step state.agent text (fn [] state.cancel-requested?)))))
    (set state.busy? true)))

;; @doc fen_web.demo.boot.tick-turn!
;; kind: function
;; signature: (tick-turn! state) -> nil
;; summary: Resume the in-flight turn coroutine once (the per-frame cooperative step), reporting a thrown error on the bus and flushing the session when the turn finishes. Mirrors interactive.fnl's on-tick turn drive.
;; tags: demo boot turn coroutine tick
(fn M.tick-turn! [state]
  (when state.turn
    (let [(ok? value) (coroutine.resume state.turn)]
      (when (not ok?)
        (events.emit {:type :error
                      :error (.. "agent task: " (first-line (tostring value)))}))
      (when (or (not ok?) (= (coroutine.status state.turn) :dead))
        (set state.busy? false)
        (set state.turn nil)
        (set state.cancel-requested? false)
        (M.flush! state)))))

(fn emit-initial-status! [opts agent]
  (let [ctx (token-util.context-token-info agent)]
    (events.emit {:type :set-status-info
                  :info {:provider (or opts.provider :anthropic)
                         :model agent.model
                         :steering-queued 0
                         :follow-up-queued 0
                         :approx-context ctx.tokens
                         :context-estimated? ctx.estimated?
                         :context-source ctx.source}})))

;; @doc fen_web.demo.boot.run
;; kind: function
;; signature: (run opts) -> nil
;; summary: Register the provider/tools/session backend/DOM presenter, build one agent from opts (:api-key/:model/:cwd/:system), wire the presenter turn-loop callbacks, and drive the active presenter's run lifecycle until the page requests shutdown. Called inside the runtime coroutine pump.
;; tags: demo boot runtime presenter agent
(fn M.run [opts]
  (let [opts (or opts {})
        kv (and _G.__fen_host _G.__fen_host.kv)
        _install (fs-kv.install! kv)
        api (api-factory.make-api :fen-web-demo nil {:privileged? true})]
    ;; Register the compositional pieces against fen's real api.
    (api.register :provider (anthropic-provider-spec))
    (tools-init.register api)
    (sessions-init.register api)
    (demo.register api)
    (session-backend-registry.set-active! :kv)
    (let [backend (session-backend-registry.find :kv)
          session (backend.open (or opts.cwd "/workspace"))
          agent (agent-mod.make-agent
                  {:provider-name :anthropic
                   :model (or opts.model "claude-haiku-4-5")
                   :system (or opts.system DEFAULT-SYSTEM)
                   :api-key opts.api-key
                   :max-tokens (or opts.max-tokens 8192)
                   :tools (tool-registry.merged [])
                   :on-event (fn [ev] (events.emit ev))})
          state (M.make-state agent session backend)
          ctx {:state state
               :on-submit (fn [line] (M.start-turn! state line))
               :on-tick (fn [] (M.tick-turn! state))
               :is-busy? (fn [] state.busy?)
               :request-cancel (fn []
                                 (when state.busy?
                                   (set state.cancel-requested? true)))
               :get-turn (fn [] state.turn)}]
      (emit-initial-status! opts agent)
      (presenter-registry.init-active-presenter ctx)
      (presenter-registry.run-active-presenter ctx)
      (backend.close session)
      nil)))

M
