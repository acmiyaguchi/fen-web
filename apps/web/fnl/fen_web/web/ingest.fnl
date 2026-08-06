;; Bus -> DOM-presenter transcript/status ingestion (fen-web#6).
;;
;; This is the DOM presenter's fold of `api.on :*` events into transcript
;; rows and a status model, with streaming-delta merge. It is a
;; near-verbatim fork of the in-tree web presenter's ingest.fnl
;; (fen/extensions/adapters/presenters/web/ingest.fnl) re-homed onto the
;; fen-web state module rather than shared. The fold is presenter-neutral --
;; it is NOT terminal/SSE shaped and only mutates state; rendering is
;; host.dom-apply's job (see dom.fnl). It is duplicated here because that
;; presenter lives in the pinned fen submodule; upstreaming a shared
;; presenter-neutral ingest into fen is tracked as fen-web#24 (see PR #23).

(local state (require :fen_web.web.state))
(local json (require :fen.util.json))

(local M {})

(fn args->string [args]
  (let [(ok? out) (pcall json.encode (or args {}))]
    (if ok? out (tostring args))))

(fn content->text [content]
  (if (= (type content) :string) content
      (= (type content) :table)
      (let [parts []]
        (each [_ item (ipairs content)]
          (if (= (type item) :string)
              (table.insert parts item)
              (and (= (type item) :table) item.text)
              (table.insert parts (tostring item.text))))
        (table.concat parts "\n"))
      (tostring (or content ""))))

(fn copy-event [ev]
  (let [out {}]
    (each [k v (pairs ev)]
      ;; Drop function fields so no non-serializable provider internals are
      ;; retained on the transcript row.
      (when (not= (type v) :function)
        (tset out k v)))
    out))

(fn find-streaming-row [row-type content-index]
  (var found nil)
  (var i (length state.transcript))
  (while (and (> i 0) (not found))
    (let [row (. state.transcript i)]
      (if (and row row.streaming? (= row.type row-type)
               (= row.content-index content-index))
          (set found row)
          (and row (not row.streaming?)
               (or (= row.type :assistant-text)
                   (= row.type :assistant-thinking)
                   (= row.type :tool-call)
                   (= row.type :tool-result)
                   (= row.type :user)))
          (set i 0)))
    (set i (- i 1)))
  found)

(fn append-assistant-delta! [row-type content-index delta]
  (let [row (or (find-streaming-row row-type content-index)
                (let [new-row {:type row-type
                               :text ""
                               :final? false
                               :streaming? true
                               :content-index content-index}]
                  (table.insert state.transcript new-row)
                  new-row))]
    (set row.text (.. (or row.text "") (or delta "")))))

(fn finish-streaming-assistant! [final?]
  (each [_ row (ipairs state.transcript)]
    (when row.streaming?
      (set row.streaming? nil)
      (set row.final? final?))))

;; @doc fen_web.web.ingest.append-event
;; kind: function
;; signature: (append-event ev) -> nil
;; summary: Fold one bus event into the DOM presenter's transcript and status state, merging streaming assistant/thinking deltas and summarizing tool calls/results.
;; tags: demo ingest events transcript status
(fn M.append-event [ev]
  (let [s state.status-info]
    (if (= ev.type :set-status-info)
        (each [k v (pairs (or ev.info {}))]
          (tset s k v))

        (= ev.type :llm-start)
        (do (set s.thinking? true)
            (when (= (or s.turn-start 0) 0)
              (set s.turn-start (os.time))))

        (= ev.type :llm-end)
        (do (set s.thinking? false)
            (when ev.usage
              (set s.last-input (or ev.usage.input s.last-input))))

        (= ev.type :tool-call)
        (do (set ev.args-pretty (args->string ev.arguments))
            (set s.running-label (tostring (or ev.name "tool")))
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :tool-result)
        (do (set s.running-label nil)
            (set ev.body-pretty (content->text (?. ev :result :content)))
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :cancelled)
        (do (set s.thinking? false)
            (set s.running-label nil)
            (set s.cancelling? false)
            (set s.turn-start 0)
            (table.insert state.transcript (copy-event ev)))

        (or (= ev.type :assistant-text) (= ev.type :assistant-thinking))
        (do (when (not= ev.final? false)
              (set s.thinking? false)
              (set s.running-label nil)
              (set s.turn-start 0))
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :assistant-text-delta)
        (append-assistant-delta! :assistant-text ev.content-index ev.delta)

        (= ev.type :assistant-thinking-delta)
        (append-assistant-delta! :assistant-thinking ev.content-index ev.delta)

        (= ev.type :assistant-stream-end)
        (do (finish-streaming-assistant! ev.final?)
            (when ev.final?
              (set s.thinking? false)
              (set s.running-label nil)
              (set s.turn-start 0)))

        (= ev.type :error)
        (do (set s.thinking? false)
            (set s.running-label nil)
            (set s.turn-start 0)
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :extension-loaded)
        (table.insert state.transcript
                      {:type :info
                       :text (.. "extension-loaded: "
                                 (tostring (or ev.name "")))})

        ;; user / queued / injected / info / unknown -- append unless it is a
        ;; presenter-control event that would only duplicate status/redraw.
        (not (= ev.type :redraw))
        (table.insert state.transcript (copy-event ev)))))

M
