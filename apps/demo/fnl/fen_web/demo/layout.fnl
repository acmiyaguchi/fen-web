;; Presenter-neutral structured fragment for the DOM presenter (fen-web#6).
;;
;; Reuses fen's compositional panel/fragment model directly: it folds the
;; registered :status and :panel contributions (api.list) plus the ingested
;; transcript into plain {:text :style} rows. Deliberately NOT the terminal
;; row helpers in fen.util.panel (box-drawing, width-based) -- fen-web#99's
;; design finding flagged those as terminal-shaped; the DOM presenter emits
;; structured rows and lets host.dom-apply/CSS own geometry and styling.
;; dom.fnl turns this fragment into a batched mutation list.

(local state (require :fen_web.demo.state))

(local M {})

(fn row [text style]
  {:text (tostring (or text "")) :style (or style :normal)})

(fn truncate [s n]
  (let [s (tostring (or s ""))]
    (if (> (length s) n)
        (.. (string.sub s 1 n) "…")
        s)))

;; @doc fen_web.demo.layout.status-fragments
;; kind: function
;; signature: (status-fragments side ctx) -> [{:name :text :style}]
;; summary: Render the registered :status contributions for one side into structured fragments, isolating a failing renderer as an error fragment.
;; tags: demo layout status fragment
(fn M.status-fragments [side ctx]
  (let [out []]
    (each [_ item (ipairs (state.api.list :status))]
      (when (= (or item.side :left) side)
        (let [(ok? r) (pcall item.render ctx)]
          (if (and ok? r r.text (not= r.text ""))
              (table.insert out {:name item.name
                                 :text (tostring r.text)
                                 :style (or r.style :status)})
              (not ok?)
              (table.insert out {:name item.name
                                 :text (.. "status-error:" (tostring item.name))
                                 :style :error})))))
    out))

;; @doc fen_web.demo.layout.panels
;; kind: function
;; signature: (panels ctx) -> [{:name :rows}]
;; summary: Render the registered :panel contributions with a positive height into structured row lists, isolating a failing panel as a single error row.
;; tags: demo layout panels fragment
(fn M.panels [ctx]
  (let [out []]
    (each [_ p (ipairs (state.api.list :panels))]
      (let [(hok? h) (pcall p.height ctx)]
        (when (and hok? (> (or h 0) 0))
          (let [(ok? rows) (pcall p.render ctx)
                norm []]
            (if ok?
                (each [_ r (ipairs (or rows []))]
                  (table.insert norm
                                (if (= (type r) :table)
                                    (row r.text (or r.style r.attr :normal))
                                    (row r :normal))))
                (table.insert norm (row (.. "panel-error:" (tostring p.name)) :error)))
            (table.insert out {:name p.name :rows norm})))))
    out))

;; @doc fen_web.demo.layout.transcript-row
;; kind: function
;; signature: (transcript-row ev) -> {:text :style}
;; summary: Convert one ingested transcript event into a structured row with a semantic style, mirroring the web presenter's row mapping without box-drawing.
;; tags: demo layout transcript row
(fn M.transcript-row [ev]
  (if (= ev.type :user)
      (row (.. "> " (or ev.text ev.content "")) :user)
      (= ev.type :assistant-text)
      (row (or ev.text "") :assistant)
      (= ev.type :assistant-thinking)
      (row (.. "Thinking: " (or ev.text "")) :dim)
      (= ev.type :tool-call)
      (row (.. "tool " (tostring (or ev.name "?")) " "
               (truncate (or ev.args-pretty "") 500)) :tool)
      (= ev.type :tool-result)
      (row (.. "tool-result " (tostring (or ev.name ev.id "")) " "
               (truncate (or ev.body-pretty "") 1200)) :dim)
      (= ev.type :error)
      (row (tostring (or ev.error ev.text "error")) :error)
      (= ev.type :queued)
      (row (.. "queued " (tostring (or ev.queue "")) ": "
               (tostring (or ev.text ""))) :dim)
      (= ev.type :info)
      (row (or ev.text "") :dim)
      (row (.. (tostring (or ev.type :event)) ": "
               (tostring (or ev.text ev.delta ""))) :dim)))

;; @doc fen_web.demo.layout.fragment
;; kind: function
;; signature: (fragment ?ctx) -> {:status-left :status-right :transcript :panels}
;; summary: Build the full structured presenter fragment (both status sides, transcript rows, and panel row lists) that the DOM diff renders each frame.
;; tags: demo layout fragment snapshot
(fn M.fragment [ctx]
  (let [ctx (or ctx {})
        status-ctx {:status-info state.status-info :state state
                    :w (or ctx.w 100)}]
    {:status-left (M.status-fragments :left status-ctx)
     :status-right (M.status-fragments :right status-ctx)
     :transcript (icollect [_ ev (ipairs state.transcript)]
                   (M.transcript-row ev))
     :panels (M.panels status-ctx)}))

M
