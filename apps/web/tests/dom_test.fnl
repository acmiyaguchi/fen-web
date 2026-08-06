;; Tests for the DOM presenter's host.dom-apply rendering: the fragment diff
;; (reconcile-children!), skeleton, per-frame render, input pump, and the
;; cooperative DOM prompt/select overlays. Runs against the table-backed
;; host.dom-apply double in support.fnl.

(local support (require :support))
(local state (require :fen_web.web.state))
(local ingest (require :fen_web.web.ingest))
(local dom (require :fen_web.web.dom))
(local init (require :fen_web.web))
(local manifest (require :fen_web.web.manifest))

(fn setup []
  (support.reset-state!)
  (let [h (support.install-host!)
        api (support.make-api)]
    (init.register api)
    h))

(fn any? [seq pred]
  (var found false)
  (each [_ x (ipairs seq) &until found] (when (pred x) (set found true)))
  found)

(fn has-op? [ops kind ?id]
  (any? ops (fn [o] (and (= o.op kind) (or (= ?id nil) (= o.id ?id))))))

(describe "fen-web demo presenter DOM rendering"
  (fn []
    (after_each (fn [] (set _G.__fen_host nil) (set _G.__fen_host_dom nil)))

    (describe "reconcile-children! fragment diff"
      (fn []
        (before_each (fn [] (support.reset-state!)))

        (it "creates new keyed children with inline text/class"
          (fn []
            (let [ops []]
              (dom.reconcile-children! "root"
                [{:id "a" :tag :div :text "A" :class "x"}
                 {:id "b" :tag :div :text "B" :class "y"}] ops)
              (assert.are.equal 2 (length ops))
              (assert.are.equal :create (. ops 1 :op))
              (assert.are.equal "a" (. ops 1 :id))
              (assert.are.equal "A" (. ops 1 :text)))))

        (it "updates only changed text/class in place, appends a new child"
          (fn []
            (dom.reconcile-children! "root"
              [{:id "a" :tag :div :text "A" :class "x"}
               {:id "b" :tag :div :text "B" :class "y"}] [])
            (let [ops []]
              (dom.reconcile-children! "root"
                [{:id "a" :tag :div :text "A2" :class "x"}
                 {:id "b" :tag :div :text "B" :class "y"}
                 {:id "c" :tag :div :text "C"}] ops)
              (assert.are.equal 2 (length ops))
              (assert.are.equal :text (. ops 1 :op))
              (assert.are.equal "A2" (. ops 1 :text))
              (assert.are.equal :create (. ops 2 :op))
              (assert.are.equal "c" (. ops 2 :id)))))

        (it "removes children dropped from the desired list"
          (fn []
            (dom.reconcile-children! "root"
              [{:id "a"} {:id "b"} {:id "c"}] [])
            (let [ops []]
              (dom.reconcile-children! "root" [{:id "a"}] ops)
              (assert.are.equal 2 (length ops))
              (assert.are.equal :remove (. ops 1 :op)))))

        (it "inserts a new child before an existing later sibling to keep order"
          (fn []
            (dom.reconcile-children! "root" [{:id "b" :tag :div}] [])
            (let [ops []]
              (dom.reconcile-children! "root"
                [{:id "a" :tag :div} {:id "b" :tag :div}] ops)
              (assert.are.equal 1 (length ops))
              (assert.are.equal :create (. ops 1 :op))
              (assert.are.equal "a" (. ops 1 :id))
              (assert.are.equal "b" (. ops 1 :before)))))

        (it "emits attr and listen ops on create only"
          (fn []
            (let [ops []]
              (dom.reconcile-children! "root"
                [{:id "f" :tag :form :listen [:submit]
                  :attrs [{:name :method :value :post}]}] ops)
              (assert.is_true (has-op? ops :create "f"))
              (assert.is_true (has-op? ops :attr "f"))
              (assert.is_true (has-op? ops :listen "f")))
            ;; a no-change second pass emits nothing
            (let [ops2 []]
              (dom.reconcile-children! "root"
                [{:id "f" :tag :form :listen [:submit]
                  :attrs [{:name :method :value :post}]}] ops2)
              (assert.are.equal 0 (length ops2)))))))

    (describe "skeleton + render"
      (fn []
        (it "ensure-skeleton! builds the mount structure once and is idempotent"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (assert.is_true state.dom.built?)
              (let [kids (h.child-ids "fen-app")]
                (assert.are.equal 5 (length kids)))
              (assert.is_true (h.exists? "fen-input"))
              (assert.is_true (. (h.node "fen-inputbar") :listeners :submit))
              ;; second call rebuilds nothing
              (dom.ensure-skeleton!)
              (assert.are.equal 5 (length (h.child-ids "fen-app"))))))

        (it "renders status fragments and transcript rows into the DOM"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (ingest.append-event {:type :set-status-info
                                    :info {:provider "openai" :model "gpt-5"}})
              (ingest.append-event {:type :user :text "hi"})
              (dom.render-frame! {})
              (assert.is_true (h.exists? "fen-sl-model"))
              (assert.are.equal "openai:gpt-5" (. (h.node "fen-sl-model") :text))
              (assert.is_true (h.exists? "fen-row-1"))
              (assert.are.equal "> hi" (. (h.node "fen-row-1") :text))
              (assert.are.equal "row style-user" (. (h.node "fen-row-1") :class)))))

        (it "updates a streaming assistant row in place across frames"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (ingest.append-event {:type :assistant-text-delta :content-index 0 :delta "Hel"})
              (dom.render-frame! {})
              (assert.are.equal "Hel" (. (h.node "fen-row-1") :text))
              (ingest.append-event {:type :assistant-text-delta :content-index 0 :delta "lo"})
              (let [ops (dom.render-frame! {})]
                (assert.are.equal "Hello" (. (h.node "fen-row-1") :text))
                ;; only a text op for the changed row (no re-create)
                (assert.is_true (has-op? ops :text "fen-row-1"))
                (assert.is_false (has-op? ops :create "fen-row-1")))))))

        (it "shows the busy panel row only while the agent is busy"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (dom.render-frame! {})
              (assert.is_false (h.exists? "fen-panel-busy"))
              (ingest.append-event {:type :tool-call :name "read" :arguments {}})
              (dom.render-frame! {})
              (assert.is_true (h.exists? "fen-panel-busy"))
              (assert.is_true (h.exists? "fen-panel-busy-r1")))))))

    (describe "input pump"
      (fn []
        (it "form submit reads the input, clears it, and starts a user turn"
          (fn []
            (let [h (setup)
                  captured {}]
              (dom.ensure-skeleton!)
              (h.dom_apply [{:op :prop :id "fen-input" :name :value :value "hello there"}])
              (h.emit "fen-inputbar" "submit")
              (dom.pump-input! {:on-submit (fn [t] (set captured.text t))})
              (assert.are.equal "hello there" captured.text)
              (assert.are.equal "" (. (h.node "fen-input") :props :value)))))

        (it "blank submit does not start a turn"
          (fn []
            (let [h (setup)
                  called {}]
              (dom.ensure-skeleton!)
              (h.dom_apply [{:op :prop :id "fen-input" :name :value :value "   "}])
              (h.emit "fen-inputbar" "submit")
              (dom.pump-input! {:on-submit (fn [_] (set called.hit true))})
              (assert.is_nil called.hit))))))

    (describe "cooperative DOM overlays (ui.select / ui.prompt)"
      (fn []
        (it "select opens a choice overlay and resolves on a click"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (let [co (coroutine.create (fn [] (dom.select {:label "pick" :choices ["alpha" "beta"]})))]
                (coroutine.resume co)
                (assert.is_true (h.exists? "fen-choice-1"))
                (assert.is_true (h.exists? "fen-choice-2"))
                (assert.is_true (. (h.node "fen-input") :props :disabled))
                (h.emit "fen-choice-2" "click")
                (dom.pump-input! {})
                (let [(_ result) (coroutine.resume co)]
                  (assert.are.equal "beta" result))
                (assert.is_false (h.exists? "fen-choice-1"))
                (assert.is_false (. (h.node "fen-input") :props :disabled))
                (assert.is_nil state.select)))))

        (it "select cancel resolves to nil"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (let [co (coroutine.create (fn [] (dom.select {:label "pick" :choices ["a"]})))]
                (coroutine.resume co)
                (h.emit "fen-choice-cancel" "click")
                (dom.pump-input! {})
                (let [(_ result) (coroutine.resume co)]
                  (assert.is_nil result))))))

        (it "prompt opens a text overlay and resolves on submit"
          (fn []
            (let [h (setup)]
              (dom.ensure-skeleton!)
              (let [co (coroutine.create (fn [] (dom.prompt {:label "name"})))]
                (coroutine.resume co)
                (assert.is_true (h.exists? "fen-prompt-input"))
                (h.dom_apply [{:op :prop :id "fen-prompt-input" :name :value :value "Ada"}])
                (h.emit "fen-prompt-form" "submit")
                (dom.pump-input! {})
                (let [(_ result) (coroutine.resume co)]
                  (assert.are.equal "Ada" result))
                (assert.is_false (h.exists? "fen-prompt-input"))
                (assert.is_nil state.prompt)))))

        (it "notify appends an info transcript row"
          (fn []
            (support.reset-state!)
            (dom.notify "heads up")
            (assert.are.equal :info (. state.transcript 1 :type))
            (assert.are.equal "heads up" (. state.transcript 1 :text))))))

    (describe "manifest"
      (fn []
        (it "excludes the state module from reload and lists behavior modules"
          (fn []
            (assert.are.equal :fen_web.web manifest.entry-module)
            (assert.are.equal :dom manifest.presenter)
            (let [excluded {}]
              (each [_ m (ipairs manifest.reload-exclude)] (tset excluded m true))
              (assert.is_true (. excluded :fen_web.web.state)))
            (let [reloaded {}]
              (each [_ m (ipairs manifest.reload-modules)] (tset reloaded m true))
              (assert.is_nil (. reloaded :fen_web.web.state))
              (assert.is_true (. reloaded :fen_web.web))))))))
