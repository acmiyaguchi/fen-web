;; Shared test support for the fen-web demo presenter specs: a table-backed
;; stand-in for the host.dom-apply primitive (the Fennel equivalent of
;; packages/bindings/src/dom/fakeDom.ts), plus a helper to reset the
;; singleton presenter state module between specs.
;;
;; The fake maintains a real element tree so specs can assert the DOM the
;; fragment diff produced, and exposes `emit` to simulate user input events
;; the presenter drains with `drain-events`.
;;
;; TEST-ONLY MIRROR of the op dispatcher in
;; packages/bindings/src/dom/applyOps.ts. The Busted harness has no TS
;; runtime, so the real dispatcher cannot be reused here; this fake must be
;; kept semantically aligned with applyOps by hand. Notably it must match:
;;   - create idempotency: create is a no-op on an existing id, then still
;;     applies any optional inline text/class (initial-set doubling);
;;   - `before` semantics: insert before the named sibling, else append;
;;   - get: absent/nil property normalizes to "" (never nil back to Lua);
;;   - mutation ops target an existing element (error otherwise).
;; When applyOps.ts changes op semantics, update this fake in lockstep.
(local state (require :fen_web.web.state))

(local M {})

;; @doc demo-test-support.make-dom-host
;; kind: function
;; signature: (make-dom-host ?root-id) -> table
;; summary: Build a table-backed host.dom-apply double implementing the create/remove/text/class/attr/prop/get/exists/listen/drain-events op vocabulary over an in-memory tree, with emit/node/child-ids/exists? test hooks.
;; tags: demo test support dom
(fn M.make-dom-host [?root-id]
  (let [root (or ?root-id "fen-app")
        h {:nodes {} :queue []}]
    (fn blank [tag id parent]
      {:tag tag :id id :parent parent :children [] :text "" :class ""
       :attrs {} :props {} :listeners {}})
    (tset h.nodes root (blank "div" root nil))
    (fn node [id]
      (or (. h.nodes id) (error (.. "fake-dom: no element " (tostring id)))))
    (fn exists? [id] (not= (. h.nodes id) nil))
    (fn index-of [seq v]
      (var idx nil)
      (each [i x (ipairs seq) &until idx] (when (= x v) (set idx i)))
      idx)
    (fn create [tag id parent before]
      (let [p (node parent)
            n (blank tag id parent)]
        (tset h.nodes id n)
        (let [at (and before (index-of p.children before))]
          (if at (table.insert p.children at id)
              (table.insert p.children id)))))
    (fn remove [id]
      (let [n (. h.nodes id)]
        (when n
          (when n.parent
            (let [sib (. (node n.parent) :children)
                  at (index-of sib id)]
              (when at (table.remove sib at))))
          (each [_ c (ipairs (icollect [_ c (ipairs n.children)] c))]
            (remove c))
          (tset h.nodes id nil))))
    (fn apply-one [op]
      (case op.op
        :create (do (when (not (exists? op.id))
                      (create op.tag op.id op.parent op.before))
                    (when (not= op.text nil) (tset (node op.id) :text op.text))
                    (when (not= op.class nil) (tset (node op.id) :class op.class))
                    true)
        :remove (do (remove op.id) true)
        :text (do (tset (node op.id) :text (or op.text "")) true)
        :class (do (tset (node op.id) :class (or op.class "")) true)
        :attr (do (if (= op.value nil)
                      (tset (. (node op.id) :attrs) op.name nil)
                      (tset (. (node op.id) :attrs) op.name (tostring op.value)))
                  true)
        :prop (do (tset (. (node op.id) :props) op.name op.value) true)
        :focus (do (tset (node op.id) :focused true) true)
        :listen (do (tset (. (node op.id) :listeners) op.event true) true)
        :get (let [v (. (. (node op.id) :props) op.name)]
               (if (= v nil) "" v))
        :exists (exists? op.id)
        :drain-events (let [out h.queue] (set h.queue []) out)
        _ (error (.. "fake-dom: unknown op " (tostring op.op)))))
    (set h.dom_apply (fn [ops] (icollect [_ op (ipairs ops)] (apply-one op))))
    (set h.emit (fn [id event value]
                  (when (. (. (node id) :listeners) event)
                    (table.insert h.queue {:id id :event event
                                           :value (or value "")}))))
    (set h.node node)
    (set h.exists? exists?)
    (set h.child-ids (fn [id] (icollect [_ c (ipairs (. (node id) :children))] c)))
    h))

;; @doc demo-test-support.install-host!
;; kind: function
;; signature: (install-host! ?root-id) -> host
;; summary: Build a fake dom host and install it at _G.__fen_host.dom_apply, returning the host for assertions.
;; tags: demo test support dom
(fn M.install-host! [?root-id]
  (let [h (M.make-dom-host ?root-id)]
    (set _G.__fen_host {:dom_apply h.dom_apply})
    (set _G.__fen_host_dom h)
    h))

;; @doc demo-test-support.make-api
;; kind: function
;; signature: (make-api) -> table
;; summary: Build a minimal extension api double supporting on/emit/register/list for :status and :panels, so the presenter's register entry point and layout fold can run under Busted.
;; tags: demo test support api
(fn M.make-api []
  (let [status [] panels [] handlers {}]
    {:on (fn [ev f]
           (when (= nil (. handlers ev)) (tset handlers ev []))
           (table.insert (. handlers ev) f))
     :register (fn [kind spec]
                 (if (= kind :status) (table.insert status spec)
                     (= kind :panel) (table.insert panels spec)))
     :list (fn [kind]
             (if (= kind :status) status
                 (= kind :panels) panels
                 []))
     :emit (fn [ev]
             (each [_ f (ipairs (or (. handlers "*") []))] (f ev))
             (each [_ f (ipairs (or (. handlers ev.type) []))] (f ev)))}))

;; @doc demo-test-support.reset-state!
;; kind: function
;; signature: (reset-state!) -> nil
;; summary: Reset the singleton presenter state module to defaults between specs so transcript/status/committed-DOM state does not leak across tests.
;; tags: demo test support state
(fn M.reset-state! []
  (set state.api nil)
  (set state.presenter-ctx nil)
  (set state.root-id "fen-app")
  (set state.quit? false)
  (set state.transcript [])
  (set state.status-info {:provider nil :model nil :last-input 0
                          :last-output 0 :last-cache-read 0
                          :last-cache-write 0 :last-usage? false
                          :usage-seen? false
                          :turn-input 0 :turn-output 0
                          :turn-cache-read 0 :turn-cache-write 0
                          :turn-usage? false
                          :cum-input 0 :cum-output 0
                          :cum-cache-read 0 :cum-cache-write 0
                          :approx-context 0 :context-estimated? true
                          :context-source :estimated :steering-queued 0
                          :follow-up-queued 0 :running-label nil
                          :thinking? false :cancelling? false
                          :turn-start 0 :spin-frame 0})
  (set state.dom {:built? false :nodes {} :children {}})
  (set state.select nil)
  (set state.prompt nil))

M
