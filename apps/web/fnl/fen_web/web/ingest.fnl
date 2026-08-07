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

(fn kind? [value keyword text]
  (or (= value keyword) (= value text)))

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

(fn ensure-status! []
  "Backfill status fields when a reload reuses a state module created by an older presenter revision."
  (when (= state.status-info nil)
    (set state.status-info {}))
  (let [s state.status-info]
    (when (= s.last-input nil) (set s.last-input 0))
    (when (= s.last-output nil) (set s.last-output 0))
    (when (= s.last-cache-read nil) (set s.last-cache-read 0))
    (when (= s.last-cache-write nil) (set s.last-cache-write 0))
    (when (= s.last-usage? nil) (set s.last-usage? false))
    (when (= s.usage-seen? nil) (set s.usage-seen? false))
    (when (= s.turn-input nil) (set s.turn-input 0))
    (when (= s.turn-output nil) (set s.turn-output 0))
    (when (= s.turn-cache-read nil) (set s.turn-cache-read 0))
    (when (= s.turn-cache-write nil) (set s.turn-cache-write 0))
    (when (= s.turn-usage? nil) (set s.turn-usage? false))
    (when (= s.cum-input nil) (set s.cum-input 0))
    (when (= s.cum-output nil) (set s.cum-output 0))
    (when (= s.cum-cache-read nil) (set s.cum-cache-read 0))
    (when (= s.cum-cache-write nil) (set s.cum-cache-write 0))
    (when (= s.approx-context nil) (set s.approx-context 0))
    (when (= s.context-estimated? nil) (set s.context-estimated? true))
    (when (= s.context-source nil) (set s.context-source :estimated))
    (when (= s.steering-queued nil) (set s.steering-queued 0))
    (when (= s.follow-up-queued nil) (set s.follow-up-queued 0))
    (when (= s.turn-start nil) (set s.turn-start 0))
    (when (= s.spin-frame nil) (set s.spin-frame 0))))

(fn token-count [value]
  (or (tonumber value) 0))

(fn usage-input [usage]
  (token-count (or usage.input usage.input_tokens)))

(fn usage-output [usage]
  (token-count (or usage.output usage.output_tokens)))

(fn usage-cache-read [usage]
  (token-count usage.cache-read))

(fn usage-cache-write [usage]
  (token-count usage.cache-write))

(fn fold-usage! [s usage]
  ;; The agent emits one canonical :llm-end usage event per provider round.
  ;; It is already merged from provider stream message_start (input_tokens)
  ;; and message_delta (output_tokens), so ingest must count only this event,
  ;; never the provider's internal SSE deltas a second time.
  ;;
  ;; Failed-round accounting is intentionally tied to that canonical event:
  ;; a failed round that emitted message_start but never reaches :llm-end
  ;; contributes nothing, while a :llm-end carrying that merged usage counts.
  ;; This mode-dependent boundary is the provider event contract; do not infer
  ;; usage from partial/error events here.
  (if usage
      (let [input (usage-input usage)
            output (usage-output usage)
            cache-read (usage-cache-read usage)
            cache-write (usage-cache-write usage)]
        (set s.last-input input)
        (set s.last-output output)
        (set s.last-cache-read cache-read)
        (set s.last-cache-write cache-write)
        (set s.last-usage? true)
        (set s.usage-seen? true)
        (set s.turn-input (+ (or s.turn-input 0) input))
        (set s.turn-output (+ (or s.turn-output 0) output))
        (set s.turn-cache-read (+ (or s.turn-cache-read 0) cache-read))
        (set s.turn-cache-write (+ (or s.turn-cache-write 0) cache-write))
        (set s.turn-usage? true)
        (set s.cum-input (+ (or s.cum-input 0) input))
        (set s.cum-output (+ (or s.cum-output 0) output))
        (set s.cum-cache-read (+ (or s.cum-cache-read 0) cache-read))
        (set s.cum-cache-write (+ (or s.cum-cache-write 0) cache-write)))
      (do
        ;; A provider can finish without usage metadata. Do not reuse the
        ;; previous round's figures as if they belonged to this round.
        (set s.last-output 0)
        (set s.last-cache-read 0)
        (set s.last-cache-write 0)
        (set s.last-usage? false))))

;; @doc fen_web.web.ingest.append-event
;; kind: function
;; signature: (append-event ev) -> nil
;; summary: Fold one bus event into the DOM presenter's transcript and status state, merging streaming assistant/thinking deltas and summarizing tool calls/results.
;; tags: demo ingest events transcript status
(fn M.append-event [ev]
  (ensure-status!)
  (let [s state.status-info]
    (if (= ev.type :set-status-info)
        (each [k v (pairs (or ev.info {}))]
          (tset s k v))

        (= ev.type :reset-conversation)
        (do
          (set state.transcript [])
          (set s.thinking? false)
          (set s.running-label nil)
          (set s.cancelling? false)
          (set s.turn-start 0)
          ;; /new and session-switch reset the conversation: the token/cost
          ;; status counts a session, so clear cumulative + last-round totals
          ;; too (else the previous session's tokens linger in the bar).
          (set s.cum-input 0)
          (set s.cum-output 0)
          (set s.cum-cache-read 0)
          (set s.cum-cache-write 0)
          (set s.last-input 0)
          (set s.last-output 0)
          (set s.last-cache-read 0)
          (set s.last-cache-write 0)
          (set s.turn-input 0)
          (set s.turn-output 0)
          (set s.turn-cache-read 0)
          (set s.turn-cache-write 0)
          (set s.usage-seen? false)
          (set s.turn-usage? false))

        (= ev.type :llm-start)
        (do (set s.thinking? true)
            (set s.last-usage? false)
            (set s.last-output 0)
            (set s.last-cache-read 0)
            (set s.last-cache-write 0)
            ;; turn-start is the boundary for one logical agent turn. A turn
            ;; may contain several provider rounds separated by tool events;
            ;; reset the turn accumulator only on its first :llm-start.
            (when (= (or s.turn-start 0) 0)
              (set s.turn-start (os.time))
              (set s.turn-input 0)
              (set s.turn-output 0)
              (set s.turn-cache-read 0)
              (set s.turn-cache-write 0)
              (set s.turn-usage? false)))

        (= ev.type :llm-end)
        (do (set s.thinking? false)
            (fold-usage! s ev.usage))

        (= ev.type :tool-call)
        (do (set ev.args-pretty (args->string ev.arguments))
            (set s.running-label (tostring (or ev.name "tool")))
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :tool-result)
        (do (set s.running-label nil)
            (set ev.body-pretty (content->text (?. ev :result :content)))
            (table.insert state.transcript (copy-event ev)))

        (= ev.type :cancelling)
        (set s.cancelling? true)

        (= ev.type :cancelled)
        (do (set s.thinking? false)
            (set s.running-label nil)
            (set s.cancelling? false)
            (set s.turn-start 0)
            ;; A cancellation can arrive after streamed deltas but before the
            ;; provider emits its normal stream-end marker. Close that row so
            ;; the next turn cannot append its first delta to old transcript.
            (finish-streaming-assistant! false)
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

(fn append-hydrated-assistant! [msg]
  (let [content msg.content]
    (if (= (type content) :string)
        (M.append-event {:type :assistant-text :text content :final? true})
        (= (type content) :table)
        (let [visible []]
          (each [i block (ipairs content)]
            (when (and (= (type block) :table)
                       (or (kind? block.type :text "text")
                           (kind? block.type :thinking "thinking")))
              (table.insert visible i)))
          (let [last-visible (. visible (length visible))]
            (each [i block (ipairs content)]
              (when (= (type block) :table)
                (if (kind? block.type :thinking "thinking")
                    (when (not= (or block.thinking "") "")
                      (M.append-event
                        {:type :assistant-thinking
                         :text block.thinking
                         :final? (= i last-visible)}))
                    (kind? block.type :text "text")
                    (when (not= (or block.text "") "")
                      (M.append-event
                        {:type :assistant-text
                         :text block.text
                         :final? (= i last-visible)}))
                    (or (kind? block.type :tool-call "tool-call")
                        (kind? block.type :tool-use "tool_use"))
                    (M.append-event
                      {:type :tool-call
                       :name block.name
                       :arguments (or block.arguments block.input)
                       :id block.id})))))))))

;; @doc fen_web.web.ingest.hydrate!
;; kind: function
;; signature: (hydrate! messages) -> nil
;; summary: Replace the presenter's transcript with local rows reconstructed from canonical persisted session messages; this is used for boot resume and session switching without emitting provider turns.
;; tags: demo ingest sessions hydration
(fn M.hydrate! [messages]
  (set state.transcript [])
  (each [_ msg (ipairs (or messages []))]
    (when (= (type msg) :table)
      (if (or (kind? msg.role :user "user")
              (kind? msg.role :human "human"))
          (M.append-event {:type :user :text (content->text msg.content)})
          (or (kind? msg.role :assistant "assistant")
              (kind? msg.role :model "model"))
          (append-hydrated-assistant! msg)
          (or (kind? msg.role :tool "tool")
              (kind? msg.role :tool-result "tool-result"))
          (M.append-event
            {:type :tool-result
             :name (or msg.tool-name msg.name)
             :id (or msg.tool-call-id msg.id)
             :result {:content msg.content
                      :details msg.details
                      :is-error? msg.is-error?}}))))
  nil)

M
