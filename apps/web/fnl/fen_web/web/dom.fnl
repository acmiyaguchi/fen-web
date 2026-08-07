;; DOM rendering for the fen-web demo presenter (fen-web#6), over the
;; host.dom-apply primitive (packages/bindings/src/dom).
;;
;; Each frame this module turns the structured fragment from layout.fnl into
;; a *fragment diff*: it compares the desired per-container child lists
;; against a committed model kept in state.dom, and emits only the create/
;; text/class/remove mutations that changed, as ONE batched host.dom-apply
;; call. That committed model lives in the reload-excluded state module, so
;; the presenter is structured for /reload to swap this behavior module
;; without re-creating live DOM nodes. That reload-ready split is verified
;; structurally (the diff and overlay state survive a re-require); an
;; end-to-end /reload cycle is not yet exercised by a test, pending
;; fen-web#19.
;;
;; User input never calls back into Lua (that would resume the agent
;; coroutine across a C-call boundary; see docs/bindings/host-protocol.md).
;; Instead `listen` ops register JS-side handlers that enqueue events, and
;; the run loop drains them with a `drain-events` query op, poll-style.

(local state (require :fen_web.web.state))
(local layout (require :fen_web.web.layout))
(local ingest (require :fen_web.web.ingest))
(local trim (. (require :fen.util.text) :trim))

(local M {})

;; --- host bridge -----------------------------------------------------------

(fn host-apply [ops]
  (let [h _G.__fen_host]
    (if (and h h.dom_apply)
        (h.dom_apply ops)
        (error "fen_web.web.dom: __fen_host.dom_apply is not installed"))))

;; --- style/id helpers ------------------------------------------------------

(fn class-token [x]
  (let [s0 (tostring (or x :normal))
        s1 (string.gsub s0 "^:" "")
        (s2 _) (string.gsub s1 "[^%w_-]" "-")]
    s2))

(fn style-class [style]
  (.. "style-" (class-token style)))

;; --- committed-model bookkeeping ------------------------------------------

(fn forget-node! [id]
  (let [kids (. state.dom.children id)]
    (when kids (each [_ k (ipairs kids)] (forget-node! k)))
    (tset state.dom.children id nil)
    (tset state.dom.nodes id nil)))

(fn create-op [v parent-id before]
  (let [op {:op :create :id v.id :parent parent-id :tag (or v.tag :div)}]
    (when before (tset op :before before))
    (when (not= v.text nil) (tset op :text v.text))
    (when (not= v.class nil) (tset op :class v.class))
    op))

(fn find-anchor [desired i committed-set]
  "Id of the first desired sibling after index i that already exists, so a
   freshly-created node inserts into the right position without moving any
   existing node."
  (var anchor nil)
  (var j (+ i 1))
  (while (and (not anchor) (<= j (length desired)))
    (let [id (. (. desired j) :id)]
      (when (. committed-set id) (set anchor id)))
    (set j (+ j 1)))
  anchor)

;; @doc fen_web.web.dom.reconcile-children!
;; kind: function
;; signature: (reconcile-children! parent-id desired ops) -> ops
;; summary: Diff a container's desired keyed vnode children against the committed model, appending create/text/class/remove ops for only what changed (recursing into children) and updating state.dom. This is the fragment diff the presenter batches per frame.
;; tags: demo dom diff reconcile
(fn M.reconcile-children! [parent-id desired ops]
  (let [committed (or (. state.dom.children parent-id) [])
        committed-set {}
        desired-ids {}]
    (each [_ id (ipairs committed)] (tset committed-set id true))
    (each [_ v (ipairs desired)] (tset desired-ids v.id true))
    ;; removals first (also drops their listener/committed bookkeeping)
    (each [_ id (ipairs committed)]
      (when (not (. desired-ids id))
        (table.insert ops {:op :remove :id id})
        (forget-node! id)))
    ;; upserts, in desired order
    (each [i v (ipairs desired)]
      (if (not (. committed-set v.id))
          (let [before (find-anchor desired i committed-set)]
            (table.insert ops (create-op v parent-id before))
            (each [_ a (ipairs (or v.attrs []))]
              (table.insert ops {:op :attr :id v.id :name a.name :value a.value}))
            (each [_ p (ipairs (or v.props []))]
              (table.insert ops {:op :prop :id v.id :name p.name :value p.value}))
            (each [_ e (ipairs (or v.listen []))]
              (table.insert ops {:op :listen :id v.id :event e}))
            (tset state.dom.nodes v.id {:text v.text :class v.class}))
          (let [prev (. state.dom.nodes v.id)]
            (when (not= prev.text v.text)
              (table.insert ops {:op :text :id v.id :text (or v.text "")})
              (set prev.text v.text))
            (when (not= prev.class v.class)
              (table.insert ops {:op :class :id v.id :class (or v.class "")})
              (set prev.class v.class))))
      (M.reconcile-children! v.id (or v.children []) ops))
    (tset state.dom.children parent-id
          (icollect [_ v (ipairs desired)] v.id))
    ops))

;; --- skeleton --------------------------------------------------------------

(fn skeleton-vnodes []
  [{:id :fen-status :tag :div :class :fen-status
    :children [{:id :fen-status-left :tag :div :class :fen-status-left}
               {:id :fen-status-right :tag :div :class :fen-status-right}]}
   {:id :fen-transcript :tag :div :class :fen-transcript}
   {:id :fen-panels :tag :div :class :fen-panels}
   {:id :fen-inputbar :tag :form :class :fen-inputbar
    :listen [:submit]
    :children [{:id :fen-input :tag :textarea :class :fen-input
                :attrs [{:name :placeholder
                         :value "Message fen…  (Enter to send; Shift+Enter for newline)"}
                        {:name :autocomplete :value :off}
                        {:name :rows :value 1}]}
               {:id :fen-send :tag :button :class :fen-send :text "Send"
                :attrs [{:name :type :value :submit}]}]}
   {:id :fen-overlay :tag :div :class :fen-overlay}])

(fn turn-busy? []
  (let [ctx state.presenter-ctx]
    (and ctx ctx.is-busy? (ctx.is-busy?))))

(fn input-vnodes []
  (let [out [{:id :fen-input :tag :textarea :class :fen-input
              :attrs [{:name :placeholder
                       :value "Message fen…  (Enter to send; Shift+Enter for newline)"}
                      {:name :autocomplete :value :off}
                      {:name :rows :value 1}]}
             {:id :fen-send :tag :button :class :fen-send :text "Send"
              :attrs [{:name :type :value :submit}]}]]
    (when (turn-busy?)
      (table.insert out
                    {:id :fen-stop :tag :button :class :fen-stop :text "Stop"
                     :attrs [{:name :type :value :button}
                             {:name "data-fen-stop" :value "true"}]
                     :listen [:click]}))
    out))

;; @doc fen_web.web.dom.ensure-skeleton!
;; kind: function
;; signature: (ensure-skeleton!) -> nil
;; summary: Build the presenter's fixed DOM skeleton (status bar, transcript, panels, input form, overlay slot) under the mount root exactly once, wiring the input-form submit listener. Idempotent across /reload because state.dom.built? persists.
;; tags: demo dom skeleton lifecycle reload
(fn M.ensure-skeleton! []
  (when (not state.dom.built?)
    (let [ops []]
      (M.reconcile-children! state.root-id (skeleton-vnodes) ops)
      (host-apply ops)
      (set state.dom.built? true))))

;; --- per-frame fragment -> vnodes -----------------------------------------

(fn status-vnodes [prefix frags]
  (icollect [_ f (ipairs frags)]
    {:id (.. prefix (class-token f.name)) :tag :span
     :text f.text :class (style-class f.style)}))

(fn transcript-vnodes [rows]
  (icollect [i r (ipairs rows)]
    {:id (.. "fen-row-" i) :tag :div :text r.text
     :class (.. "row " (style-class r.style))}))

(fn panels-vnodes [panels]
  (icollect [_ p (ipairs panels)]
    (let [pid (.. "fen-panel-" (class-token p.name))]
      {:id pid :tag :div :class :panel
       :children (icollect [i r (ipairs p.rows)]
                   {:id (.. pid "-r" i) :tag :div :text r.text
                    :class (.. "row " (style-class r.style))})})))

;; @doc fen_web.web.dom.render-frame!
;; kind: function
;; signature: (render-frame! ?ctx) -> ops
;; summary: Build the structured fragment, diff every region container (both status sides, transcript, panels) against the committed model, and apply the combined mutation list as one batched host.dom-apply call. Returns the emitted ops (for tests). Auto-scrolls the transcript to the tail when rows were appended.
;; tags: demo dom render frame diff
(fn M.render-frame! [ctx]
  (let [fragment (layout.fragment ctx)
        transcript (transcript-vnodes fragment.transcript)
        grew? (> (length transcript)
                 (length (or (. state.dom.children :fen-transcript) [])))
        ops []]
    (M.reconcile-children! :fen-status-left
                           (status-vnodes "fen-sl-" fragment.status-left) ops)
    (M.reconcile-children! :fen-status-right
                           (status-vnodes "fen-sr-" fragment.status-right) ops)
    (M.reconcile-children! :fen-inputbar (input-vnodes) ops)
    (M.reconcile-children! :fen-transcript transcript ops)
    (M.reconcile-children! :fen-panels (panels-vnodes fragment.panels) ops)
    (when (and grew? (not state.select) (not state.prompt))
      (table.insert ops {:op :prop :id :fen-transcript
                         :name :scrollTop :value 999999999}))
    (when (> (length ops) 0) (host-apply ops))
    ops))

;; --- input pump ------------------------------------------------------------

(fn drain-events! []
  (let [res (host-apply [{:op :drain-events}])]
    (or (. res 1) [])))

(fn input-value [id]
  (let [res (host-apply [{:op :get :id id :name :value}])]
    (tostring (or (. res 1) ""))))

(fn set-input-disabled! [disabled?]
  (host-apply [{:op :prop :id :fen-input :name :disabled :value disabled?}]))

(fn focus! [id]
  (host-apply [{:op :focus :id id}]))

(fn choice-id? [id]
  (not= nil (string.match id "^fen%-choice%-")))

(fn choice-index [id]
  (if (= id "fen-choice-cancel") :cancel
      (tonumber (string.match id "^fen%-choice%-(%d+)$"))))

(fn resolve-select! [result]
  (when (and state.select (not state.select.done?))
    (set state.select.result result)
    (set state.select.done? true)))

(fn resolve-prompt! [value]
  (when (and state.prompt (not state.prompt.done?))
    (set state.prompt.result value)
    (set state.prompt.done? true)))

;; @doc fen_web.web.dom.pump-input!
;; kind: function
;; signature: (pump-input! ctx) -> nil
;; summary: Drain queued DOM input events and dispatch them: form submit starts a user turn via ctx.on-submit (when no overlay is open), a choice click resolves the active select, and the prompt form submit resolves the active prompt.
;; tags: demo dom input pump events
(fn M.pump-input! [ctx]
  (each [_ ev (ipairs (drain-events!))]
    (let [id (tostring (or ev.id ""))
          etype (tostring (or ev.event ""))]
      (if (and (= id "fen-stop") (= etype :click))
          (when ctx.request-cancel (ctx.request-cancel))

          (and state.prompt (not state.prompt.done?)
               (= id "fen-prompt-form") (= etype :submit))
          (resolve-prompt! (input-value :fen-prompt-input))

          (and state.select (not state.select.done?)
               (choice-id? id) (= etype :click))
          (let [idx (choice-index id)]
            (resolve-select! (if (= idx :cancel) nil
                                 idx (. state.select.choices idx)
                                 nil)))

          (and (= id "fen-inputbar") (= etype :submit)
               (not state.prompt) (not state.select))
          (let [text (input-value :fen-input)]
            (when (not= (trim text) "")
              (host-apply [{:op :prop :id :fen-input :name :value :value ""}])
              (ctx.on-submit text)))))))

;; --- overlays (ui.prompt / ui.select) -------------------------------------

(fn choice-label [choice]
  (if (= (type choice) :table)
      (tostring (or choice.label choice.name choice.value choice))
      (tostring choice)))

(fn open-overlay! [children]
  (let [ops []]
    (M.reconcile-children! :fen-overlay
                           [{:id :fen-overlay-box :tag :div :class :overlay-box
                             :children children}]
                           ops)
    (host-apply ops)))

(fn close-overlay! []
  (let [ops []]
    (M.reconcile-children! :fen-overlay [] ops)
    (when (> (length ops) 0) (host-apply ops))))

(fn select-children [sel]
  [{:id :fen-overlay-title :tag :div :class :overlay-title :text sel.label}
   {:id :fen-overlay-list :tag :div :class :overlay-list
    :children (icollect [i choice (ipairs (or sel.choices []))]
                {:id (.. "fen-choice-" i) :tag :button :class :overlay-choice
                 :text (choice-label choice) :listen [:click]
                 :attrs [{:name :type :value :button}]})}
   {:id :fen-choice-cancel :tag :button :class :overlay-cancel :text "Cancel"
    :listen [:click] :attrs [{:name :type :value :button}]}])

(fn prompt-children [pr]
  [{:id :fen-overlay-title :tag :div :class :overlay-title :text pr.label}
   {:id :fen-prompt-form :tag :form :class :overlay-form :listen [:submit]
    :children [{:id :fen-prompt-input :tag :input :class :overlay-input
                :attrs [{:name :type :value :text} {:name :autocomplete :value :off}]}
               {:id :fen-prompt-submit :tag :button :class :overlay-submit
                :text "OK" :attrs [{:name :type :value :submit}]}]}])

(fn cancellation-requested? []
  (let [ctx state.presenter-ctx]
    (and ctx ctx.state ctx.state.cancel-requested?)))

(fn await-overlay! [get-done?]
  ;; A Stop/Esc can arrive while a tool is waiting on a modal prompt/select.
  ;; Let that cooperative turn unwind rather than leaving the overlay parked
  ;; forever waiting for a user response that cancellation has superseded.
  (while (and (not (get-done?)) (not (cancellation-requested?)))
    (coroutine.yield)))

;; @doc fen_web.web.dom.select
;; kind: function
;; signature: (select opts) -> Choice|nil
;; summary: Real DOM implementation of api.ui.select: render a modal choice overlay, disable the input, and cooperatively await a click (or cancel) by yielding the active turn coroutine until pump-input! resolves it. Degrades to a transcript hint and nil when called with no yieldable turn.
;; tags: demo dom ui select
(fn M.select [opts]
  (let [opts (or opts {})]
    (if (not (coroutine.isyieldable))
        (do (ingest.append-event
              {:type :info
               :text (.. (tostring (or opts.label "select"))
                         ": DOM select needs an active turn; returning nil")})
            nil)
        (do
          (set state.select {:label (tostring (or opts.label "select"))
                             :choices (or opts.choices [])
                             :result nil :done? false})
          (open-overlay! (select-children state.select))
          (set-input-disabled! true)
          (await-overlay! (fn [] state.select.done?))
          (close-overlay!)
          (set-input-disabled! false)
          (let [r state.select.result]
            (set state.select nil)
            r)))))

;; @doc fen_web.web.dom.prompt
;; kind: function
;; signature: (prompt opts) -> string|nil
;; summary: Real DOM implementation of api.ui.prompt: render a modal text-input overlay, focus it, and cooperatively await submit by yielding the active turn coroutine until pump-input! resolves it. Degrades to a transcript hint and nil when called with no yieldable turn.
;; tags: demo dom ui prompt
(fn M.prompt [opts]
  (let [opts (or opts {})]
    (if (not (coroutine.isyieldable))
        (do (ingest.append-event
              {:type :info
               :text (.. (tostring (or opts.label "prompt"))
                         ": DOM prompt needs an active turn; returning nil")})
            nil)
        (do
          (set state.prompt {:label (tostring (or opts.label "prompt"))
                             :result nil :done? false})
          (open-overlay! (prompt-children state.prompt))
          (set-input-disabled! true)
          (focus! :fen-prompt-input)
          (await-overlay! (fn [] state.prompt.done?))
          (close-overlay!)
          (set-input-disabled! false)
          (let [r state.prompt.result]
            (set state.prompt nil)
            r)))))

;; @doc fen_web.web.dom.notify
;; kind: function
;; signature: (notify text opts?) -> nil
;; summary: Real DOM implementation of api.ui.notify: append an info row to the transcript, surfaced on the next rendered frame.
;; tags: demo dom ui notify
(fn M.notify [text _opts]
  (ingest.append-event {:type :info :text (tostring text)}))

M
