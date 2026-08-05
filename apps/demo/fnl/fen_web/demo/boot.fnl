;; Browser boot orchestration for the fen-web demo (fen-web#7).
;;
;; This is the single-page app's Fennel entry point: it registers the
;; provider/tools/session-backend/DOM presenter against fen's real extension
;; api, builds one agent, and drives the active presenter's turn loop — the
;; browser analog of a fen interactive session (fen.interactive's `run!`),
;; scoped down to what the page needs. It runs inside the coroutine pump the
;; HTML shell drives (packages/runtime createCoroutinePump; see
;; docs/runtime/boot.md), so the only JS/Lua boundary crossings are the
;; __fen_host primitives (kv, fetch, dom-apply) fen-web's bindings own.
;;
;; It deliberately does NOT reuse fen's CLI-shaped `run!` wholesale: that
;; pulls arg parsing, the full extension loader's on-disk manifest discovery
;; (which needs io.popen/`find`, absent in-VM), models.json provider
;; resolution, steering queues, termbox2 teardown, and os.exit process
;; control — none of which apply in-page. But the *lifecycle mechanisms* that
;; do apply are reused from fen's own modules rather than re-implemented:
;;
;;   - fen.run_state       — the mutable run-state record shape/closures.
;;   - fen.turn_submit     — submit/queue/reject policy + cooperative turn
;;                           coroutine construction (agent.step auto-detects
;;                           cooperative mode and yields between phases).
;;   - fen.turn_lifecycle  — the :agent-turn-complete event.
;;   - fen.session_lifecycle — make-flush's hold-until-assistant persistence
;;                           policy, the :message-appended flush bridge
;;                           (install!/uninstall!), and close!.
;;
;; The turn/tick loop below mirrors fen.interactive's on-tick exactly
;; (emitting the canonical :runtime-tick / :agent-turn-complete events and
;; resuming the cooperative turn coroutine once per rendered frame) so
;; extensions relying on those contracts see the same event stream they do
;; under the TUI.

(local api-factory (require :fen.core.extensions.loader.api))
(local manifest-mod (require :fen.core.extensions.loader.manifest))
(local register (require :fen.core.extensions.register))
(local fs-kv (require :fen_web.shims.fs_kv))
(local sessions-init (require :fen_web.sessions))
(local anthropic (require :fen.extensions.provider_anthropic.anthropic_messages))
(local session-backend-registry
       (require :fen.core.extensions.register.session_backend))
(local tool-registry (require :fen.core.extensions.register.tool))
(local presenter-registry (require :fen.core.extensions.register.presenter))
(local agent-mod (require :fen.core.agent))
(local events (require :fen.core.extensions.events))
(local token-util (require :fen.util.tokens))
(local text (require :fen.util.text))
(local trim (. text :trim))
(local first-line (. text :first-line))
(local run-state (require :fen.run_state))
(local turn-submit (require :fen.turn_submit))
(local turn-lifecycle (require :fen.turn_lifecycle))
(local session-lifecycle (require :fen.session_lifecycle))

(local M {})

(local DEFAULT-SYSTEM
  (.. "You are fen, a coding agent running entirely in the user's browser. "
      "The workspace is a virtual filesystem backed by IndexedDB; use the "
      "read/write/edit/find/grep/ls tools to work in it. Be concise."))

(local SUPPORTED-PROVIDERS {:anthropic true})

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

;; @doc fen_web.demo.boot.load-extension!
;; kind: function
;; signature: (load-extension! manifest-module ?reload?) -> {:owner :manifest :reload-modules :reload-exclude}
;; summary: In-page analog of fen.core.extensions.loader's module-spec load, built from the loader's own PUBLIC pieces (api factory, manifest reader, owner-scoped registry) so the manifest/reload/owner contract is real without the CLI loader (whose compiler dep pulls fen.runtime, absent in-VM). Reads :entry-module/:reload-modules/:reload-exclude, drops prior owner contributions first, clears the right package.loaded entries, then requires the entry and calls its register fn with a privileged owner-scoped api.
;; tags: demo boot extensions loader manifest reload
(fn M.load-extension! [manifest-module ?reload?]
  (let [manifest (require manifest-module)
        owner (tostring (or (?. manifest :name) manifest-module))
        entry-module (manifest-mod.entry-module-of manifest)]
    (when (not entry-module)
      (error (.. "fen_web.demo.boot: manifest " (tostring manifest-module)
                 " has no :entry-module")))
    (let [reload-modules (manifest-mod.reload-modules manifest [entry-module])
          reload-exclude (manifest-mod.reload-exclude manifest)]
      ;; Loader owner-cleanup semantics: drop this owner's prior
      ;; contributions before (re)loading so a reload cannot leave
      ;; half-active presenters/tools/handlers behind.
      (register.unregister-by-owner owner)
      (if ?reload?
          ;; Reload: clear reload-modules (never the excludes, which hold
          ;; persistent presenter/DOM state) so their bodies re-run.
          (let [exclude {}]
            (each [_ m (ipairs (or reload-exclude []))] (tset exclude m true))
            (each [_ m (ipairs (or reload-modules []))]
              (when (not (. exclude m)) (tset package.loaded m nil))))
          ;; First load: clear only an already-cached entry module so its
          ;; self-registering body re-runs, matching the loader.
          (when (. package.loaded entry-module)
            (tset package.loaded entry-module nil)))
      (let [entry (require entry-module)
            register-fn (manifest-mod.entry-register entry)
            api (api-factory.make-api owner manifest {:privileged? true})]
        (when (= (type register-fn) :function)
          (register-fn api))
        {:owner owner :manifest manifest
         :reload-modules reload-modules :reload-exclude reload-exclude}))))

;; @doc fen_web.demo.boot.reload-extension!
;; kind: function
;; signature: (reload-extension! manifest-module) -> {:owner ...}
;; summary: Reload a previously loaded fen-web extension by manifest module, honoring its manifest reload-modules/reload-exclude. A full in-page /reload command is deferred to fen-web#19; this exposes the underlying honest reload so the contract is not dead code.
;; tags: demo boot extensions reload
(fn M.reload-extension! [manifest-module]
  (M.load-extension! manifest-module true))

;; Register a manifest-less first-party contribution (provider, session
;; backend) with an owner-scoped privileged api so owner cleanup still
;; applies, the same way the loader wraps every extension's register call.
(fn register-inline! [owner register-fn]
  (let [api (api-factory.make-api owner nil {:privileged? true})]
    (register-fn api)
    owner))

;; @doc fen_web.demo.boot.flush-closure
;; kind: function
;; signature: (flush-closure backend agent session) -> fn
;; summary: fen.session_lifecycle.make-flush's hold-until-assistant persistence closure, reused verbatim so early user-only turns aren't orphaned to kv before the first assistant message lands.
;; tags: demo boot sessions persistence
(fn M.flush-closure [backend agent session]
  (session-lifecycle.make-flush backend agent session 0))

;; @doc fen_web.demo.boot.on-tick
;; kind: function
;; signature: (on-tick state) -> nil
;; summary: One presenter frame's runtime tick, mirroring fen.interactive's on-tick: emit :runtime-tick, resume the in-flight cooperative turn coroutine once, and on completion clear busy/turn, flush the session, and emit the canonical :agent-turn-complete event (reporting a thrown error on the bus first).
;; tags: demo boot turn coroutine tick lifecycle
(fn M.on-tick [state]
  (events.emit {:type :runtime-tick :busy? (not (not state.busy?))
                :agent state.agent})
  (when state.turn
    (let [(ok? value) (coroutine.resume state.turn)]
      (when (not ok?)
        (events.emit {:type :error
                      :error (.. "agent task: " (first-line (tostring value)))
                      :traceback (debug.traceback state.turn (tostring value))}))
      (when (or (not ok?) (= (coroutine.status state.turn) :dead))
        (if ok?
            (set state.turn-result value)
            (set state.turn-error value))
        (set state.busy? false)
        (set state.turn nil)
        (set state.cancel-requested? false)
        (when state.flush (state.flush))
        (turn-lifecycle.emit-complete! state ok? value)))))

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

(fn emit-agent-started! [agent opts]
  (events.emit {:type :agent-started
                :agent agent
                :provider (or opts.provider :anthropic)
                :model agent.model
                :cwd (or opts.cwd "/workspace")}))

(fn emit-agent-shutdown! [agent reason ?error]
  (events.emit {:type :agent-shutdown
                :agent agent
                :reason (or reason :normal)
                :error ?error}))

(fn resolve-api-key [spec]
  ;; Resolve the key through fen's real credential seam: the provider's
  ;; :api-key-var is looked up with os.getenv, which fen_web.shims.fs_kv maps
  ;; to kv path env/apikey/<VAR> — exactly where the settings form stores it
  ;; (docs/platform/shims.md). No plaintext key is marshalled through a JS
  ;; global or duplicated in the VM.
  (let [var-name (tostring (or (?. spec :api-key-var) :ANTHROPIC_API_KEY))
        key (os.getenv var-name)]
    (when (or (= key nil) (= (trim key) ""))
      (error (.. "fen_web.demo.boot: no API key for " var-name
                 " — set it via the settings form (stored under env/apikey/"
                 var-name ")")))
    key))

;; @doc fen_web.demo.boot.run
;; kind: function
;; signature: (run opts) -> nil
;; summary: Register the provider/tools/session backend/DOM presenter through the loader-owned api (manifest-driven for the tool and presenter extensions), build one agent (key resolved via the env/apikey seam), wire the presenter turn-loop callbacks to fen's shared run_state/turn_submit lifecycle, and drive the presenter run/shutdown lifecycle to a cooperative stop. Called inside the runtime coroutine pump.
;; tags: demo boot runtime presenter agent lifecycle
(fn M.run [opts]
  (let [opts (or opts {})
        provider (tostring (or opts.provider :anthropic))]
    (when (not (. SUPPORTED-PROVIDERS provider))
      (error (.. "fen_web.demo.boot: unsupported provider '" provider
                 "'; only 'anthropic' is wired today (see docs/apps/demo.md)")))
    (let [kv (and _G.__fen_host _G.__fen_host.kv)
          _install (fs-kv.install! kv)
          spec (anthropic-provider-spec)
          api-key (resolve-api-key spec)]
      ;; Register the compositional pieces against fen's real api. The tool
      ;; and presenter extensions load through their manifests so their
      ;; reload-modules/reload-exclude and owner cleanup are real; the
      ;; manifest-less provider and session backend register with their own
      ;; owner-scoped privileged api.
      (register-inline! :fen_web_provider_anthropic
                        (fn [api] (api.register :provider spec)))
      (M.load-extension! :fen_web.tools.manifest)
      (register-inline! :fen_web_sessions sessions-init.register)
      (M.load-extension! :fen_web.demo.manifest)
      (session-backend-registry.set-active! :kv)
      (let [backend (session-backend-registry.find :kv)
            session (backend.open (or opts.cwd "/workspace"))
            _info (session-backend-registry.set-info!
                    (session-lifecycle.backend-info backend session) session)
            agent (agent-mod.make-agent
                    {:provider-name :anthropic
                     :model (or opts.model "claude-haiku-4-5")
                     :system (or opts.system DEFAULT-SYSTEM)
                     :api-key api-key
                     :max-tokens (or opts.max-tokens 8192)
                     :tools (tool-registry.merged [])
                     :on-event (fn [ev] (events.emit ev))})
            flush (M.flush-closure backend agent session)
            _state-box {:state nil}
            state (run-state.make
                    {: opts
                     :on-event (fn [ev] (events.emit ev))
                     : agent : session : flush
                     :session-backend backend
                     :state-box _state-box
                     : session-lifecycle
                     :submit-user-turn!
                     (fn [st line ?opts]
                       (turn-submit.submit! st line ?opts agent-mod.step
                                            events.emit))})
            ctx {:state state
                 :on-submit (fn [line]
                              (state.submit-user-turn! line {:emit-user? true}))
                 :on-tick (fn [] (M.on-tick state))
                 :is-busy? (fn [] state.busy?)
                 :request-cancel (fn []
                                   (when state.busy?
                                     (set state.cancel-requested? true)))
                 :get-turn (fn [] state.turn)}]
        ;; Bridge :message-appended into the session flush closure so the
        ;; agent's per-message appends persist as they land (not just at
        ;; end of turn) — the same durability install fen.interactive does.
        (session-lifecycle.install! state)
        ;; Cooperative shutdown seam: the HTML shell's DemoSession.stop calls
        ;; this to ask the presenter run loop to quit at the next frame, so
        ;; teardown (presenter shutdown, session close, :agent-shutdown) runs
        ;; instead of the JS side hard-closing the VM mid-loop.
        (set _G.__fen_demo_request_stop
             (fn [] (let [s (require :fen_web.demo.state)] (set s.quit? true))))
        (emit-initial-status! opts agent)
        (emit-agent-started! agent opts)
        (let [(init-ok? init-err) (presenter-registry.init-active-presenter ctx)]
          (when (not init-ok?)
            (session-lifecycle.close! backend session)
            (session-lifecycle.uninstall!)
            (emit-agent-shutdown! agent :crashed init-err)
            (error (.. "presenter init failed: " (tostring init-err)))))
        (let [(run-ok? run-result) (presenter-registry.run-active-presenter ctx)]
          (presenter-registry.shutdown-active-presenter ctx)
          (session-lifecycle.close! backend session)
          (session-lifecycle.uninstall!)
          (emit-agent-shutdown! agent (if run-ok? :normal :crashed)
                                (when (not run-ok?) run-result))
          (set _G.__fen_demo_request_stop nil)
          nil)))))

M
