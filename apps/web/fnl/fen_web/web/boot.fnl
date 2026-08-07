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
(local openai-completions (require :fen.extensions.provider_openai.openai_completions))
(local session-backend-registry
       (require :fen.core.extensions.register.session_backend))
(local tool-registry (require :fen.core.extensions.register.tool))
(local presenter-registry (require :fen.core.extensions.register.presenter))
(local agent-mod (require :fen.core.agent))
(local events (require :fen.core.extensions.events))
(local token-util (require :fen.util.tokens))
(local path (require :fen.util.path))
(local text (require :fen.util.text))
(local trim (. text :trim))
(local first-line (. text :first-line))
(local run-state (require :fen.run_state))
(local turn-submit (require :fen.turn_submit))
(local turn-lifecycle (require :fen.turn_lifecycle))
(local session-lifecycle (require :fen.session_lifecycle))
(local web-ingest (require :fen_web.web.ingest))
(local redact (require :fen.util.redact))
(local json (require :fen.util.json))
(local log (require :fen.util.log))

(local M {})

;; wasmoon exposes io.popen but raises "popen not supported" when called.
;; The agent_state companion's runtime snapshot asks fen.version to inspect
;; the runtime, so install the unavailable-pipe fallback while boot loads — not
;; only when the optional Codex provider is selected. A nil decorator means
;; "reuse retained", just like ?register-opts in load-extension!; this
;; unconditional preload keeps the companion safe for every provider.
(when (= (type io) :table)
  (tset io :popen (fn [_] nil)))

;; A reload caller often has no reason to know the extension's boot flags.
;; Retain the last explicit registration options per manifest so omitting
;; ?register-opts on reload does not silently disable an opt-in tool such as
;; web_fetch. Retain API decorators too: a safety wrapper installed for
;; agent_state must survive the same reload path. Store shallow option copies
;; so a later caller mutation cannot rewrite the retained contract.
(local last-register-opts {})
(local last-api-decorators {})

(fn copy-table [source]
  (let [out {}]
    (each [k v (pairs (or source {}))] (tset out k v))
    out))

(local DEFAULT-SYSTEM
  (.. "You are fen, a coding agent running entirely in the user's browser. "
      "The workspace is a virtual filesystem backed by IndexedDB; use the "
      "read/write/edit/find/grep/ls tools to work in it. When you build a web "
      "app, render it with preview_refresh; further preview tools (query/"
      "click/fill/eval/screenshot) and web_fetch are discoverable via "
      "tool_search; search for them before assuming a capability is "
      "missing. Use preview_console to see the app's console output and "
      "errors. Be concise."))

;; Keep this VM validation set in sync with the selectable provider ids in
;; apps/web/src/settings.ts (`PROVIDERS`). The TypeScript list controls the
;; settings gate; this Fennel list controls which providers boot can wire.
(local SUPPORTED-PROVIDERS {:anthropic true :openai true :openrouter true
                             :openai-codex true})
(local DEFAULT-ANTHROPIC-MODEL "claude-haiku-4-5")
(local DEFAULT-OPENAI-MODEL "gpt-5.4-nano")
(local DEFAULT-OPENROUTER-MODEL "anthropic/claude-haiku-4.5")
(local DEFAULT-CODEX-MODEL "gpt-5.6-luna")
(local OPENAI-BASE-URL "https://api.openai.com/v1")
(local OPENROUTER-BASE-URL "https://openrouter.ai/api/v1")

;; Provider order per docs/apps/web.md: Anthropic first because
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
    (set spec.default-model DEFAULT-ANTHROPIC-MODEL)
    (set spec.api-key-var :ANTHROPIC_API_KEY)
    spec))

;; OpenAI and OpenRouter share Fen's Chat Completions adapter. The adapter's
;; provider metadata remains :openai because it describes the wire protocol;
;; the registry name (and therefore the selectable provider) is distinct for
;; OpenRouter. `base-url` is an existing provider-options seam in fen#492's
;; vicinity; no extra-header seam exists in pinned v0.17 (see docs/apps/web.md).
;; `spec.base-url` below is registry metadata; the `provider-options.base-url`
;; passed in M.run is the behavioral endpoint used for the actual request.
(fn openai-compatible-provider-spec [name default-model api-key-var base-url]
  (let [spec {}]
    (each [k v (pairs openai-completions)] (tset spec k v))
    (set spec.name name)
    (set spec.default-model default-model)
    (set spec.api-key-var api-key-var)
    (set spec.base-url base-url)
    spec))

;; ChatGPT/Codex subscription provider (dev-mode only in practice): OAuth
;; creds come from the kv-seeded auth.json (browserBoot.ts seeds the local
;; fen CLI's ~/.config/fen/auth.json via the Vite dev bridge), and requests
;; ride the dev server's /__codex-proxy because chatgpt.com/backend-api has
;; no CORS headers. Mirrors fen's openai init.fnl auth-provider-spec shape.
;; Required lazily (not at module top): the openai extension tree is only in
;; the source map when the bundle includes it (sources.ts); node tests that
;; hand-build an anthropic-only map must still be able to load this module.
(fn codex-provider-spec []
  (let [codex-responses (require :fen.extensions.provider_openai.openai_codex_responses)
        spec {}]
    (each [k v (pairs codex-responses)] (tset spec k v))
    (set spec.name :openai-codex)
    (set spec.default-model DEFAULT-CODEX-MODEL)
    (set spec.auth-backend :openai-codex)
    spec))

(fn provider-spec-for [provider]
  (case provider
    "anthropic" (anthropic-provider-spec)
    "openai" (openai-compatible-provider-spec
                :openai DEFAULT-OPENAI-MODEL :OPENAI_API_KEY OPENAI-BASE-URL)
    "openrouter" (openai-compatible-provider-spec
                   :openrouter DEFAULT-OPENROUTER-MODEL :OPENROUTER_API_KEY
                   OPENROUTER-BASE-URL)
    "openai-codex" (codex-provider-spec)
    _ nil))

;; @doc fen_web.web.boot.supported-provider?
;; kind: function
;; signature: (supported-provider? provider) -> boolean
;; summary: Return whether the web boot has a provider registration for the given provider id.
;; tags: demo boot provider validation
(fn M.supported-provider? [provider]
  (. SUPPORTED-PROVIDERS (tostring provider)))

;; @doc fen_web.web.boot.provider-spec-for
;; kind: function
;; signature: (provider-spec-for provider) -> table|nil
;; summary: Build the provider registration spec for a selectable web provider, including its key variable and endpoint.
;; tags: demo boot provider resolution
(fn M.provider-spec-for [provider]
  (provider-spec-for (tostring provider)))

;; @doc fen_web.web.boot.model-for
;; kind: function
;; signature: (model-for opts ?provider) -> string
;; summary: Resolve the explicit browser setting or the one conservative default for the provider.
;; tags: demo boot model settings
(fn M.model-for [opts ?provider]
  (let [opts (or opts {})
        provider (tostring (or ?provider opts.provider :anthropic))]
    (or (when (and opts.model (not= opts.model "")) opts.model)
        (case provider
          "openai" DEFAULT-OPENAI-MODEL
          "openrouter" DEFAULT-OPENROUTER-MODEL
          "openai-codex" DEFAULT-CODEX-MODEL
          _ DEFAULT-ANTHROPIC-MODEL))))

(fn replace-secret [text secret]
  "Replace one exact secret without treating it as a Lua pattern."
  (if (or (= secret nil) (= secret ""))
      text
      (let [parts []
            n (length text)]
        (var from 1)
        (var done? false)
        (while (not done?)
          (let [(start end) (string.find text secret from true)]
            (if start
                (do
                  (table.insert parts (string.sub text from (- start 1)))
                  (table.insert parts "[redacted]")
                  (set from (+ end 1)))
                (do
                  (table.insert parts (string.sub text from n))
                  (set done? true)))))
        (table.concat parts ""))))

(fn redact-string [value secrets]
  (if (= value nil)
      nil
      (let [;; fen.util.redact's historical `sk%-%w+` matcher stops at the
            ;; hyphen in sk-ant-... keys. Scrub that provider shape first so
            ;; the shared pass cannot leave a suffix behind.
            initial (string.gsub (tostring value)
                                 "sk%-ant%-[%w_-]+"
                                 "[redacted]")]
        (var out initial)
        (set out (redact.scrub-string out))
        (each [_ secret (ipairs (or secrets []))]
          (when (= (type secret) :string)
            (set out (replace-secret out secret))))
        out)))

(fn credential-field? [key]
  (let [name (string.lower (tostring key))
        contains? (fn [needle]
                    (not= nil (string.find name needle 1 true)))]
    ;; `api-key-var` and its cousins identify an environment variable name,
    ;; not the credential value; keep that useful metadata visible.
    (if (string.match name "[-_]var$")
        false
        (or (contains? "api-key")
            (contains? "api_key")
            (contains? "apikey")
            (contains? "secret")
            (contains? "password")
            (contains? "credential")
            (contains? "authorization")
            (contains? "access-token")
            (contains? "refresh-token")
            (contains? "cookie")
            (= name "access")
            (= name "refresh")
            (= name "access_token")
            (= name "refresh_token")
            (= name "token")
            (= name "key")))))

(fn redact-surface [value secrets ?depth ?seen]
  "Copy a tool-facing value while removing credential fields and exact keys.
   This is intentionally local to the web agent_state registration: the core
   extension is shared with trusted desktop runtimes and must remain read-only
   without a browser-specific secret channel."
  (let [depth (or ?depth 0)
        kind (type value)]
    (if (> depth 8)
        "[truncated]"
        (= kind :string)
        (redact-string value secrets)
        (or (= kind :number) (= kind :boolean) (= kind :nil))
        value
        (= kind :table)
        (let [seen (or ?seen {})]
          (if (. seen value)
              "[cycle]"
              (do
                (tset seen value true)
                (let [out {}]
                  (each [key child (pairs value)]
                    (when (or (= (type key) :string)
                              (= (type key) :number))
                      (tset out key
                            (if (credential-field? key)
                                "[redacted]"
                                (redact-surface child secrets (+ depth 1) seen)))))
                  (tset seen value nil)
                  out))))
        (= kind :function) "[function]"
        (redact-string value secrets))))

(fn credential-secrets [kv api-key]
  "Collect only credential values already present in the browser VM. This
   keeps the exact-secret redaction list aligned with SettingsStore's
   env/apikey namespace and the dev Codex auth record without crossing back
   into JS."
  (let [out []]
    (fn add! [value]
      ;; Very short values are too collision-prone for global replacement
      ;; (for example, a typo'd key could erase ordinary prose).
      (when (and (= (type value) :string) (>= (length value) 8))
        (table.insert out value)))
    (add! api-key)
    (when (and kv (= (type kv.list) :function) (= (type kv.get) :function))
      (each [_ key (ipairs (or (kv.list "env/apikey/") []))]
        (add! (kv.get key)))
      (let [raw (kv.get "//.config/fen/auth.json")]
        (when raw
          (let [(ok? auth) (pcall json.decode raw)]
            (when ok?
              (fn collect-credential [value ?field]
                (if (= (type value) :table)
                    (each [key child (pairs value)]
                      (collect-credential child key))
                    (when (and ?field (credential-field? ?field))
                      (add! value))))
              (collect-credential auth nil))))))
    out))

;; Export the web-only redaction seam so busted can exercise the exact
;; transformations used by the browser decorator instead of relying only on
;; an end-to-end provider request.
(set M.replace-secret replace-secret)
(set M.redact-string redact-string)
(set M.credential-field? credential-field?)
(set M.redact-surface redact-surface)
(set M.credential-secrets credential-secrets)

(fn safe-agent-state-api [api secrets]
  "Give the shared agent_state extension a browser-safe API view. The
   extension's normal provider/model registries contain implementation records
   that are safe for trusted runtimes but may include an API key in a web VM."
  (let [safe (copy-table api)
        safe-models (copy-table api.models)
        safe-session (copy-table api.session)
        safe-diagnostics (copy-table api.diagnostics)
        safe-introspect (copy-table api.introspect)]
    (set safe.list (fn [kind]
                     (redact-surface (api.list kind) secrets)))
    (set safe.register
         (fn [kind spec]
           (if (and (= kind :tool)
                    (or (= (tostring spec.name) "agent_state")
                        (= (tostring spec.name) "models")))
               (let [safe-spec (copy-table spec)
                     execute spec.execute]
                 (when (= (type execute) :function)
                   (set safe-spec.execute
                        (fn [args ctx ?yield-fn]
                          ;; Redact the agent context before the companion
                          ;; renders/truncates it. Post-result exact matching
                          ;; remains a second guard, but cannot be the first
                          ;; line of defense against max_bytes oracles.
                          (let [safe-ctx (redact-surface ctx secrets)]
                            (redact-surface
                              (execute args safe-ctx ?yield-fn)
                              secrets)))))
                 (api.register kind safe-spec))
               (api.register kind spec))))
    (set safe-models.list
         (fn [opts]
           (redact-surface (api.models.list opts) secrets)))
    (set safe-models.inspect
         (fn [opts query]
           (redact-surface (api.models.inspect opts query) secrets)))
    ;; model-info in the companion calls these members directly rather than
    ;; going through models.list/inspect, so keep those call sites inside the
    ;; same pre-truncation redaction boundary too.
    (when (= (type api.models.dynamic-cache) :function)
      (set safe-models.dynamic-cache
           (fn [] (redact-surface (api.models.dynamic-cache) secrets))))
    (when (= (type api.models.resolve) :function)
      (set safe-models.resolve
           (fn [query available]
             (redact-surface (api.models.resolve query available) secrets))))
    (when (= (type api.models.canonical-id) :function)
      (set safe-models.canonical-id
           (fn [model-ref]
             (redact-string (api.models.canonical-id model-ref) secrets))))
    (set safe.models safe-models)
    (set safe-session.info
         (fn [] (redact-surface (api.session.info) secrets)))
    (when (= (type api.session.active-backend) :function)
      (set safe-session.active-backend
           (fn [] (redact-surface (api.session.active-backend) secrets))))
    (set safe.session safe-session)
    (set safe-diagnostics.list-errors
         (fn [] (redact-surface (api.diagnostics.list-errors) secrets)))
    (set safe-diagnostics.error-log-path
         (fn [] (redact-string (api.diagnostics.error-log-path) secrets)))
    (set safe.diagnostics safe-diagnostics)
    (set safe-introspect.collect
         (fn [?owner ?ctx]
           (redact-surface (api.introspect.collect ?owner ?ctx) secrets)))
    (set safe.introspect safe-introspect)
    ;; agent_state requires fen.util.log directly, bypassing the extension API.
    ;; Replace only the shared module's read method, retaining its original
    ;; cursor semantics and ensuring log records are scrubbed before the
    ;; companion's max_bytes truncation. Keep one raw function so reloads do
    ;; not build an unbounded wrapper chain.
    (let [raw (or (. log "__fen_web_raw_list_recent") log.list-recent)]
      (tset log "__fen_web_raw_list_recent" raw)
      (tset log :list-recent
            (fn [?after-seq]
              (let [(records truncated?) (raw ?after-seq)]
                (values (redact-surface records secrets) truncated?)))))
    safe))

(set M.safe-agent-state-api safe-agent-state-api)

;; @doc fen_web.web.boot.load-extension!
;; kind: function
;; signature: (load-extension! manifest-module ?reload? ?register-opts ?api-decorator) -> {:owner :manifest :reload-modules :reload-exclude}
;; summary: In-page analog of fen.core.extensions.loader's module-spec load, built from the loader's own PUBLIC pieces (api factory, manifest reader, owner-scoped registry) so the manifest/reload/owner contract is real without the CLI loader (whose compiler dep pulls fen.runtime, absent in-VM). Reads :entry-module/:reload-modules/:reload-exclude, drops prior owner contributions first, clears the right package.loaded entries, then requires the entry and calls its register fn with a privileged owner-scoped api and retained boot options. An optional API decorator is used for the web agent_state registration so secrets are redacted before the shared extension sees registry data.
;; tags: demo boot extensions loader manifest reload
(fn M.load-extension! [manifest-module ?reload? ?register-opts ?api-decorator]
  (let [manifest (require manifest-module)
        owner (tostring (or (?. manifest :name) manifest-module))
        entry-module (manifest-mod.entry-module-of manifest)
        register-opts (if (= ?register-opts nil)
                          (or (. last-register-opts manifest-module) {})
                          ?register-opts)
        api-decorator (if (= ?api-decorator nil)
                          (. last-api-decorators manifest-module)
                          ?api-decorator)]
    (tset last-register-opts manifest-module (copy-table register-opts))
    (tset last-api-decorators manifest-module api-decorator)
    (when (not entry-module)
      (error (.. "fen_web.web.boot: manifest " (tostring manifest-module)
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
            raw-api (api-factory.make-api owner manifest {:privileged? true})
            api (if (= (type api-decorator) :function)
                    (api-decorator raw-api)
                    raw-api)]
        (when (= (type register-fn) :function)
          (register-fn api register-opts))
        {:owner owner :manifest manifest
         :reload-modules reload-modules :reload-exclude reload-exclude}))))

;; @doc fen_web.web.boot.reload-extension!
;; kind: function
;; signature: (reload-extension! manifest-module ?register-opts) -> {:owner ...}
;; summary: Reload a previously loaded fen-web extension by manifest module, honoring its manifest reload-modules/reload-exclude and preserving optional registration flags.
;; tags: demo boot extensions reload
(fn M.reload-extension! [manifest-module ?register-opts]
  (M.load-extension! manifest-module true ?register-opts))

;; Register a manifest-less first-party contribution (provider, session
;; backend) with an owner-scoped privileged api so owner cleanup still
;; applies, the same way the loader wraps every extension's register call.
(fn register-inline! [owner register-fn]
  (let [api (api-factory.make-api owner nil {:privileged? true})]
    (register-fn api)
    owner))

;; @doc fen_web.web.boot.flush-closure
;; kind: function
;; signature: (flush-closure backend agent session) -> fn
;; summary: fen.session_lifecycle.make-flush's hold-until-assistant persistence closure, reused verbatim so early user-only turns aren't orphaned to kv before the first assistant message lands.
;; tags: demo boot sessions persistence
(fn M.flush-closure [backend agent session]
  (session-lifecycle.make-flush backend agent session 0))

;; @doc fen_web.web.boot.parse-command
;; kind: function
;; signature: (parse-command line) -> {:name string :args string}|nil
;; summary: Parse only slash-prefixed input into a command name and trimmed argument string; ordinary messages return nil and remain on the normal provider-turn path.
;; tags: demo boot slash commands
(fn M.parse-command [line]
  (let [line (or line "")]
    (when (= (string.sub line 1 1) "/")
      (let [body (trim (string.sub line 2))
            (name args) (string.match body "^(%S+)%s*(.-)%s*$")]
        ;; A lone "/" (or "/   ") has no command name — treat it as ordinary
        ;; input (nil) rather than dispatching to a bogus "Unknown command:
        ;; /nil" branch.
        (when name
          {:name (string.lower name)
           :args (or args "")})))))

;; @doc fen_web.web.boot.open-or-resume-session
;; kind: function
;; signature: (open-or-resume-session backend cwd) -> {:session :messages :resumed?}
;; summary: Resume the newest non-empty session for a cwd and return its canonical messages, or allocate a new session when none exists.
;; tags: demo boot sessions resume
(fn M.open-or-resume-session [backend cwd]
  (let [latest (backend.latest cwd)]
    (if latest
        (let [messages (or (backend.load latest) [])
              session (backend.open-existing latest)]
          (if session
              {:session session :messages messages :resumed? true}
              {:session (backend.open cwd) :messages [] :resumed? false}))
        {:session (backend.open cwd) :messages [] :resumed? false})))

(fn emit-local! [type text]
  (events.emit {:type type :text text}))

(fn session-cwd [state]
  (or (?. state.opts :cwd) "/workspace"))

(fn install-session! [state backend session messages ?close-current?]
  (when (and ?close-current? state.close-session state.session)
    (state.close-session state.session))
  (set state.session session)
  (session-backend-registry.set-info!
    (session-lifecycle.backend-info backend session) session)
  (set state.agent
       (state.make-agent-from-opts state.opts state.on-event state.agent-extra))
  (set state.agent.messages [])
  (each [_ message (ipairs (or messages []))]
    (table.insert state.agent.messages message))
  (set state.flush
       (state.make-flush state.agent state.session (length (or messages []))))
  (events.emit {:type :reset-conversation})
  (web-ingest.hydrate! messages)
  (events.emit {:type :set-status-info
                :info {:provider state.opts.provider
                       :model state.agent.model
                       :thinking-status state.agent.thinking-status}})
  state.session)

(fn format-session-record [index record]
  (.. (tostring index) ". " (tostring (or record.id record.path "?"))
      " — " (tostring (or record.title "untitled"))
      " (" (tostring (or record.timestamp "unknown time")) ", "
      (tostring (or record.message-count 0)) " messages)"))

(fn list-sessions! [state]
  (let [backend state.session-backend
        records (if (and backend backend.list)
                    (backend.list (session-cwd state) 50)
                    [])]
    (if (= (length records) 0)
        (emit-local! :info "No sessions for this workspace.")
        (do
          (emit-local! :info "Sessions (newest first):")
          (each [i record (ipairs records)]
            (emit-local! :info (format-session-record i record)))
          (emit-local! :info "Use /sessions use <id> or /sessions delete <id>.")))))

(fn resume-session! [state target]
  (let [backend state.session-backend
        cwd (session-cwd state)
        id (and backend (backend.find cwd target))]
    (if (not id)
        (emit-local! :error (.. "Session not found: " (tostring target)))
        (let [messages (or (backend.load id) [])
              session (backend.open-existing id)]
          (if (not session)
              (emit-local! :error (.. "Could not open session: " (tostring id)))
              (do
                (install-session! state backend session messages true)
                (emit-local! :info
                             (.. "Resumed session " (tostring id) " ("
                                 (tostring (length messages)) " messages)."))))))))

(fn new-session! [state]
  (if state.busy?
      (emit-local! :error "Cannot start a new session while a turn is running.")
      (let [backend state.session-backend
            session (backend.open (session-cwd state))]
        (install-session! state backend session [] true)
        (emit-local! :info "New session started."))))

(fn delete-session! [state target]
  (let [backend state.session-backend
        cwd (session-cwd state)
        id (and backend (backend.find cwd target))]
    (if (not id)
        (emit-local! :error (.. "Session not found: " (tostring target)))
        (if (or state.busy? (not= (type backend.delete) :function))
            (emit-local! :error
                         (if state.busy?
                             "Cannot delete a session while a turn is running."
                             "The active session backend cannot delete sessions."))
            (let [active? (and state.session
                                (= (tostring state.session.id) (tostring id)))]
              (backend.delete id)
              (if active?
                  (do
                    (let [session (backend.open cwd)]
                      (install-session! state backend session [] true))
                    (emit-local! :info
                                 (.. "Deleted session " (tostring id)
                                     "; started a new session.")))
                  (emit-local! :info (.. "Deleted session " (tostring id) "."))))))))

(fn sessions-command! [state args]
  (let [(action target) (string.match (trim args) "^(%S+)%s*(.*)$")
        action (and action (string.lower action))
        target (trim (or target ""))]
    (if (or (= action nil) (= action "") (= action "list"))
        (list-sessions! state)
        (= action "delete")
        (if (= target "")
            (emit-local! :error "Usage: /sessions delete <id>")
            (delete-session! state target))
        (or (= action "use") (= action "resume"))
        (if (= target "")
            (emit-local! :error "Usage: /sessions use <id>")
            (if state.busy?
                (emit-local! :error "Cannot switch sessions while a turn is running.")
                (resume-session! state target)))
        ;; A bare target is a convenient shorthand for switching from a list.
        (if state.busy?
            (emit-local! :error "Cannot switch sessions while a turn is running.")
            (resume-session! state (trim args))))))

(fn help-command! []
  (each [_ line (ipairs [
    "/new                 Start a fresh conversation"
    "/sessions            List saved sessions"
    "/sessions use <id>  Resume a saved session"
    "/sessions delete <id>  Delete a saved session"
    "/help                Show this help"])]
    (emit-local! :info line)))

(fn dispatch-command! [state command]
  (case command.name
    "new" (new-session! state)
    "sessions" (sessions-command! state command.args)
    "help" (help-command!)
    _ (emit-local! :error (.. "Unknown command: /" (tostring command.name)
                              ". Try /help."))))

;; @doc fen_web.web.boot.submit-line!
;; kind: function
;; signature: (submit-line! state line) -> result|nil
;; summary: Route slash-prefixed input to the local command dispatcher and leave ordinary input on the shared turn-submit path.
;; tags: demo boot slash commands turns
(fn M.submit-line! [state line]
  (let [command (M.parse-command line)]
    (if command
        (dispatch-command! state command)
        (state.submit-user-turn! line {:emit-user? true}))))

;; @doc fen_web.web.boot.on-tick
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
  ;; :api-key-var is looked up with fen.util.path.getenv, fulfilled by the
  ;; runtime's path backend with kv path env/apikey/<VAR> — exactly where the
  ;; settings form stores it (docs/platform/shims.md). No plaintext key is
  ;; marshalled through a JS global or duplicated in the VM.
  (let [var-name (tostring (or (?. spec :api-key-var) :ANTHROPIC_API_KEY))
        key (path.getenv var-name)]
    (when (or (= key nil) (= (trim key) ""))
      (error (.. "fen_web.web.boot: no API key for " var-name
                 " — set it via the settings form (stored under env/apikey/"
                 var-name ")")))
    key))

;; @doc fen_web.web.boot.run
;; kind: function
;; signature: (run opts) -> nil
;; summary: Register the provider/tools/session backend/DOM presenter through the loader-owned api (manifest-driven for the tool and presenter extensions), build one agent (key resolved via the env/apikey seam), wire the presenter turn-loop callbacks to fen's shared run_state/turn_submit lifecycle, and drive the presenter run/shutdown lifecycle to a cooperative stop. Called inside the runtime coroutine pump.
;; tags: demo boot runtime presenter agent lifecycle
(fn M.run [opts]
  (let [opts (or opts {})
        provider (tostring (or opts.provider :anthropic))]
    (when (not (M.supported-provider? provider))
      (error (.. "fen_web.web.boot: unsupported provider '" provider
                 "'; only 'anthropic', 'openai', 'openrouter', and "
                 "'openai-codex' are wired today (see docs/apps/web.md)")))
    (let [kv (and _G.__fen_host _G.__fen_host.kv)
          ;; Settings/models use the runtime's storage/path preloads directly;
          ;; fs-kv remains for the direct Codex auth keychain and diagnostics.
          _install (fs-kv.install! kv)
          ;; First-load starter project (fen-web#9) is seeded atomically and
          ;; durably into the persistent store BEFORE this VM boots (JS side:
          ;; IndexedDbKv.seedIfEmpty in browserBoot.ts), so the synchronous kv
          ;; view already reflects a consistent, fully-seeded vfs here. Seeding
          ;; the durable store in JS (not this coroutine's snapshot) is what
          ;; makes it race-safe across tabs and all-or-nothing on failure — the
          ;; Lua coroutine cannot await the IndexedDB transaction that gives
          ;; those guarantees.
          codex? (= provider "openai-codex")
          spec (provider-spec-for provider)
          ;; Codex authenticates via the OAuth auth-backend (creds read from
          ;; the kv-seeded auth.json at request time), not an env-var key.
          api-key (if codex? nil (resolve-api-key spec))]
      ;; Register the compositional pieces against fen's real api. The tool
      ;; and presenter extensions load through their manifests so their
      ;; reload-modules/reload-exclude and owner cleanup are real; the
      ;; manifest-less provider and session backend register with their own
      ;; owner-scoped privileged api.
      (if codex?
          (register-inline! :fen_web_provider_openai_codex
                            (fn [api]
                              (local codex-auth
                                     (require :fen.extensions.provider_openai.openai_codex_oauth))
                              (api.register :auth-backend
                                            {:name :openai-codex
                                             :description "ChatGPT/Codex OAuth creds from the kv-seeded auth.json."
                                             :configured? codex-auth.configured?
                                             :get-fresh-creds! codex-auth.get-fresh-creds!})
                              (api.register :provider spec)))
          (= provider "anthropic")
          (register-inline! :fen_web_provider_anthropic
                            (fn [api] (api.register :provider spec)))
          ;; OpenAI and OpenRouter are two registry names over the same
          ;; Chat Completions implementation. OpenRouter's documented
          ;; HTTP-Referer/X-Title headers cannot be added in v0.17 because
          ;; this adapter has no extra-headers option (fen#492).
          (register-inline! :fen_web_provider_openai
                            (fn [api] (api.register :provider spec))))
      ;; Web fetching is a deliberate capability: its registration is gated
      ;; by opts.enable-web-fetch and defaults false in the JS boot options.
      ;; Stage only this manifest's option shape, then use the ordinary
      ;; no-opts load path; load-extension! consumes the retained options and
      ;; the same defaulting path is what reload-extension! exercises.
      (tset last-register-opts :fen_web.tools.manifest
            {:enable-web-fetch (= true opts.enable-web-fetch)})
      (M.load-extension! :fen_web.tools.manifest)
      ;; Demo-only preview tools (fen-web#8): the agent drives the app it just
      ;; built in the vfs through the sandboxed iframe over host.preview.
      (M.load-extension! :fen_web.web.preview.manifest)
      (register-inline! :fen_web_sessions sessions-init.register)
      (M.load-extension! :fen_web.web.manifest)
      (session-backend-registry.set-active! :kv)
      (let [backend (session-backend-registry.find :kv)
            cwd (or opts.cwd "/workspace")
            opened (M.open-or-resume-session backend cwd)
            session opened.session
            loaded-messages opened.messages
            _info (session-backend-registry.set-info!
                    (session-lifecycle.backend-info backend session) session)
            ;; Load the companion after the active session handle is installed.
            ;; This keeps any future companion-owned state restore on the same
            ;; per-session KV handle used by the normal flush bridge.
            _agent-state
              (M.load-extension! :fen.extensions.agent_state.manifest false nil
                                  (fn [api]
                                    (safe-agent-state-api
                                      api (credential-secrets kv api-key))))
            model (M.model-for opts provider)
            make-agent (fn []
                         (agent-mod.make-agent
                    {:provider-name (if codex? :openai-codex
                                        (if (= provider "openai") :openai
                                            (if (= provider "openrouter")
                                                :openrouter
                                                :anthropic)))
                     :model model
                     :system (or opts.system DEFAULT-SYSTEM)
                     :api-key api-key
                     ;; ChatGPT's private backend has no CORS headers; route
                     ;; Codex through the Vite dev proxy. Public OpenAI and
                     ;; OpenRouter use their browser-direct HTTPS endpoints.
                     ;; `provider-options.base-url` is the behavioral seam;
                     ;; `spec.base-url` is only registry metadata. The compat
                     ;; flag is required for the provider to request the final
                     ;; streaming usage chunk used by the web status bar.
                     :provider-options (if codex?
                                          {:base-url "/__codex-proxy"}
                                          (if (= provider "openai")
                                              {:base-url OPENAI-BASE-URL
                                               :compat {:supportsUsageInStreaming true}}
                                              (if (= provider "openrouter")
                                                  {:base-url OPENROUTER-BASE-URL
                                                   :compat {:supportsUsageInStreaming true}}
                                                  {})))
                     :max-tokens (or opts.max-tokens 8192)
                     :tools (tool-registry.merged [])
                     ;; The vfs is rooted at `/`; cwd remains session metadata
                     ;; and does not narrow the virtual workspace tree.
                     :tool-context (fn [_]
                                     {:cwd (or opts.cwd "/workspace")
                                      :workspace-root "/"})
                     :on-event (fn [ev] (events.emit ev))}))
            agent (make-agent)
            _ (each [_ message (ipairs loaded-messages)]
                (table.insert agent.messages message))
            flush (session-lifecycle.make-flush backend agent session
                                                 (length loaded-messages))
            _state-box {:state nil}
            state (run-state.make
                    {: opts
                     :on-event (fn [ev] (events.emit ev))
                     : agent : session : flush
                     :session-backend backend
                     :state-box _state-box
                     :make-agent-from-opts
                     (fn [_opts _on-event _agent-extra] (make-agent))
                     : session-lifecycle
                     :submit-user-turn!
                     (fn [st line ?opts]
                       (turn-submit.submit! st line ?opts agent-mod.step
                                            events.emit))})
            cancel! (fn []
                      (if state.busy?
                          (do
                            (set state.cancel-requested? true)
                            (events.emit {:type :cancelling})
                            true)
                          false))
            ctx {:state state
                 :on-submit (fn [line]
                              (M.submit-line! state line))
                 :on-tick (fn [] (M.on-tick state))
                 :is-busy? (fn [] state.busy?)
                 :request-cancel cancel!
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
             (fn [] (let [s (require :fen_web.web.state)] (set s.quit? true))))
        ;; JS calls this hook for Stop/Esc. It returns whether a live turn
        ;; existed so the shell can keep idle cancellation a no-op; the host
        ;; poller abort is performed by DemoSession.cancel immediately after
        ;; this hook returns.
        (set _G.__fen_demo_request_cancel cancel!)
        (emit-initial-status! opts agent)
        ;; Replay canonical persisted messages into the presenter only. They
        ;; are already in agent.messages and the flush starts after them, so
        ;; boot hydration cannot duplicate storage entries.
        (web-ingest.hydrate! loaded-messages)
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
          (when (not run-ok?)
            ;; presenter-registry invokes :run through pcall. Re-raise after
            ;; lifecycle cleanup so the JS coroutine pump reports the fatal
            ;; error instead of treating a dead presenter as normal exit.
            (error (.. "presenter run failed: " (tostring run-result))))
          nil)))))

M
