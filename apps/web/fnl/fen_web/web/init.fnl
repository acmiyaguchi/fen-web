;; fen-web demo DOM presenter (fen-web#6).
;;
;; A presenter register-kind extension that replaces the termbox2 TUI with a
;; browser DOM UI driven entirely through host.dom-apply, while reusing fen's
;; compositional model unchanged: it contributes :status and :panel items and
;; folds `api.on :*` bus events into a transcript (ingest.fnl), exactly like
;; the in-tree TUI/web presenters. layout.fnl turns that state into a
;; structured fragment and dom.fnl diffs it into one batched mutation list
;; per frame. Persistent state lives in the reload-excluded state module so
;; the presenter is structured for /reload to swap behavior in-page without
;; losing the transcript or DOM. A full /reload cycle is not yet covered by
;; a test (pending fen-web#19); the split is verified only structurally.

(local state (require :fen_web.web.state))
(local ingest (require :fen_web.web.ingest))
(local dom (require :fen_web.web.dom))
(local fmt-tokens (. (require :fen.util.tokens) :fmt-tokens))
(local pricing (require :fen_web.web.pricing))

(local M {})

(local SPINNER ["⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏"])

(fn spin-char []
  (let [frame (or state.status-info.spin-frame 0)
        idx (+ (% frame (length SPINNER)) 1)]
    (or (. SPINNER idx) "⠋")))

(fn busy-label []
  (let [s state.status-info]
    (or s.running-label (if s.thinking? "thinking" ""))))

(fn busy? []
  (not= (busy-label) ""))

(fn busy-height [_ctx]
  (if (busy?) 1 0))

(fn busy-render [_ctx]
  (if (busy?)
      (let [s state.status-info
            start (or s.turn-start 0)
            elapsed (if (= start 0) "" (.. (tostring (- (os.time) start)) "s"))]
        (set s.spin-frame (+ (or s.spin-frame 0) 1))
        [{:text (.. (spin-char) " " (busy-label)
                    (if (not= elapsed "") (.. "  " elapsed) ""))
          :style :dim}])
      []))

(fn token-pair [input output]
  ;; Keep the labels fixed and compact so a growing session does not change
  ;; the fragment shape or unexpectedly widen the status bar.
  (.. (fmt-tokens (or input 0)) "/"
      (fmt-tokens (or output 0)) " tok"))

;; @doc fen_web.web.run
;; kind: function
;; signature: (run ctx) -> nil
;; summary: Presenter :run lifecycle. Builds the DOM skeleton once, then loops: drain and dispatch input, advance the active agent turn via ctx.on-tick, render one diffed frame, and cooperatively yield to the JS event loop (the runtime coroutine pump) until asked to quit.
;; tags: demo presenter run loop cooperative
(fn M.run [ctx]
  (set state.presenter-ctx ctx)
  (dom.ensure-skeleton!)
  (dom.render-frame! ctx)
  (var alive? true)
  (while (and alive? (not state.quit?))
    (dom.pump-input! ctx)
    ;; Tick every frame (not only while busy) so the canonical :runtime-tick
    ;; event fires each idle frame too, matching fen.interactive's on-tick
    ;; contract; on-tick itself only resumes a turn when one is in flight.
    ;; Do not swallow a host/presenter tick failure: it poisons this VM and
    ;; must reach the JS pump so the fatal UI can flush and close it.
    (when ctx.on-tick
      (let [(ok? err) (pcall ctx.on-tick)]
        (when (not ok?) (error (.. "runtime tick failed: " (tostring err))))))
    (dom.render-frame! ctx)
    ;; The browser boot drives run inside a coroutine pump (docs/runtime/
    ;; boot.md); yielding hands the frame to the JS event loop so pending
    ;; fetch promises and timers make progress. With no pump (e.g. a bare
    ;; harness) there is nothing to yield to, so stop rather than hot-spin.
    (if (coroutine.isyieldable)
        (coroutine.yield)
        (set alive? false))))

;; @doc fen_web.web.init
;; kind: function
;; signature: (init ctx) -> nil
;; summary: Presenter :init lifecycle. Captures the run context and builds the DOM skeleton so the first frame can render immediately.
;; tags: demo presenter init lifecycle
(fn M.init [ctx]
  (set state.presenter-ctx ctx)
  (dom.ensure-skeleton!))

;; @doc fen_web.web.shutdown
;; kind: function
;; signature: (shutdown ctx) -> nil
;; summary: Presenter :shutdown lifecycle. Clears the run context and marks the loop to quit; the DOM is left in place for the page to tear down.
;; tags: demo presenter shutdown lifecycle
(fn M.shutdown [_ctx]
  (set state.quit? true)
  (set state.presenter-ctx nil))

;; Lifecycle/plumbing bus events with no transcript representation in this
;; presenter, mirroring fen's TUI PRESENTER-CONTROL-EVENTS: they either have
;; dedicated handling (status/redraw) or are pure lifecycle signals for
;; extensions. :set-status-info is deliberately NOT here because this
;; presenter's ingest folds it into the status model. :agent-started/
;; :agent-shutdown/:agent-turn-complete/:runtime-tick/:message-appended are
;; the canonical fen.interactive turn lifecycle events; the demo emits them
;; for extension parity but they are not user-facing transcript rows.
(local PRESENTER-CONTROL-EVENTS
  {:dismiss true
   :reinit-presenter true
   :redraw true
   :runtime-tick true
   :agent-started true
   :agent-turn-complete true
   :agent-shutdown true
   :message-appended true
   :model-catalog-updated true})

;; High-frequency streaming deltas are presenter-facing (ingest folds them
;; into the transcript) but must not reach the diagnostics ring: a long
;; streamed answer would evict the llm-start/tool-call/error context the
;; ring exists to preserve, and each delta would pay a full table marshal
;; on the coroutine's synchronous path.
(local DIAGNOSTICS-SKIP-EVENTS
  {:assistant-text-delta true
   :assistant-thinking-delta true})

(fn M.register [api]
  (set state.api api)

  (api.on :*
          (fn [ev]
            (when (not (. PRESENTER-CONTROL-EVENTS ev.type))
              (ingest.append-event ev)
              ;; One-way Lua -> JS observation seam. Keep the tap inside the
              ;; non-control branch: :runtime-tick is emitted every frame and
              ;; must not evict real turn events or marshal the whole agent
              ;; table into JS 60 times per second. pcall is belt-and-braces
              ;; protection against a hostile JS payload/observer.
              (when (not (. DIAGNOSTICS-SKIP-EVENTS ev.type))
                (let [h _G.__fen_host]
                  (when (and h h.diagnostics_event)
                    (pcall h.diagnostics_event ev)))))))

  ;; /reload re-runs register; re-mark the skeleton so the persisted DOM
  ;; model is reused rather than rebuilt.
  (api.on :reinit-presenter
          (fn [ctx]
            (set state.presenter-ctx ctx)
            (dom.ensure-skeleton!)))

  (api.register :status
                {:name :model
                 :side :left
                 :order 10
                 :render (fn [_ctx]
                           (let [s state.status-info]
                             ;; The model id already implies the provider
                             ;; (claude-* / gpt-*); dropping the prefix buys
                             ;; ~10 chars on a 390px viewport (#49).
                             {:text (tostring (or s.model s.provider "?"))
                              :style :status}))})

  (api.register :status
                {:name :context
                 :side :left
                 :order 20
                 :render (fn [_ctx]
                           (let [s state.status-info]
                             {:text (.. "ctx:"
                                        (if (= s.context-estimated? false) "" "~")
                                        (fmt-tokens
                                          (or s.approx-context s.last-input)))
                              :style :status}))})

  (api.register :status
                {:name :tokens
                 :side :left
                 :order 25
                 :render (fn [_ctx]
                           (let [s state.status-info]
                             ;; Do not put an all-zero usage fragment in the
                             ;; first frame; it also keeps the mobile bar
                             ;; stable until the first provider round.
                             (when s.usage-seen?
                               {:text (token-pair s.cum-input s.cum-output)
                                :style :status})))})

  (api.register :status
                {:name :steering-queue
                 :side :left
                 :order 30
                 :render (fn [_ctx]
                           (let [n (or state.status-info.steering-queued 0)]
                             (when (> n 0)
                               {:text (.. "steer:" (tostring n)) :style :status})))})

  (api.register :status
                {:name :follow-up-queue
                 :side :left
                 :order 40
                 :render (fn [_ctx]
                           (let [n (or state.status-info.follow-up-queued 0)]
                             (when (> n 0)
                               {:text (.. "follow:" (tostring n)) :style :status})))})

  (api.register :status
                {:name :turn-tokens
                 :side :right
                 :order 20
                 :render (fn [_ctx]
                           (let [s state.status-info]
                             (when s.turn-usage?
                               {:text (.. "turn:" (token-pair s.turn-input s.turn-output))
                                :style :status})))} )

  (api.register :status
                {:name :cost
                 :side :right
                 :order 30
                 :render (fn [_ctx]
                           (let [s state.status-info
                                 text (when s.usage-seen?
                                        (pricing.format-cost
                                          s.model
                                          (or s.cum-input 0)
                                          (or s.cum-output 0)
                                          (or s.cum-cache-read 0)
                                          (or s.cum-cache-write 0)))]
                             (when text {:text text :style :status})))} )

  (api.register :status
                {:name :attention
                 :side :right
                 :order 10
                 :render (fn [_ctx]
                           (when state.status-info.cancelling?
                             {:text "cancelling…" :style :status}))})

  (api.register :panel
                {:name :busy
                 :description "DOM presenter spinner row shown while the agent is busy."
                 :placement :above-input
                 :order 10
                 :height busy-height
                 :render busy-render})

  (api.register :presenter
                {:name :dom
                 :active? true
                 :init (fn [ctx] (M.init ctx))
                 :shutdown (fn [ctx] (M.shutdown ctx))
                 :run (fn [ctx] (M.run ctx))
                 :ui {:notify (fn [text opts] (dom.notify text opts))
                      :prompt (fn [opts] (dom.prompt opts))
                      :select (fn [opts] (dom.select opts))}})

  (api.register :introspect
                {:name :runtime
                 :description "Current DOM presenter transcript/status/overlay summary"
                 :snapshot (fn [_]
                             (let [s state.status-info]
                               {:root-id state.root-id
                                :skeleton-built? state.dom.built?
                                :transcript-count (length (or state.transcript []))
                                :presenter-active? (not= state.presenter-ctx nil)
                                :quit? state.quit?
                                :active-select? (not= state.select nil)
                                :active-prompt? (not= state.prompt nil)
                                :status {:provider s.provider
                                         :model s.model
                                         :approx-context s.approx-context
                                         :last-input s.last-input
                                         :last-output s.last-output
                                         :last-cache-read s.last-cache-read
                                         :last-cache-write s.last-cache-write
                                         :last-usage? s.last-usage?
                                         :usage-seen? s.usage-seen?
                                         :turn-input s.turn-input
                                         :turn-output s.turn-output
                                         :turn-cache-read s.turn-cache-read
                                         :turn-cache-write s.turn-cache-write
                                         :turn-usage? s.turn-usage?
                                         :cum-input s.cum-input
                                         :cum-output s.cum-output
                                         :cum-cache-read s.cum-cache-read
                                         :cum-cache-write s.cum-cache-write
                                         :estimated-cost (pricing.estimate
                                                           s.model
                                                           (or s.cum-input 0)
                                                           (or s.cum-output 0)
                                                           (or s.cum-cache-read 0)
                                                           (or s.cum-cache-write 0))
                                         :steering-queued s.steering-queued
                                         :follow-up-queued s.follow-up-queued
                                         :running-label s.running-label
                                         :thinking? s.thinking?
                                         :cancelling? s.cancelling?
                                         :turn-active? (> (or s.turn-start 0) 0)}}))})

  true)

M
