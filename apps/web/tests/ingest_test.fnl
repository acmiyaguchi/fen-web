;; Tests for the DOM presenter's bus -> transcript/status fold
;; (fen_web.web.ingest): streaming-delta merge, tool call/result
;; summaries, and status-info folding.

(local support (require :support))
(local state (require :fen_web.web.state))
(local ingest (require :fen_web.web.ingest))

(describe "fen-web demo presenter ingest"
  (fn []
    (before_each (fn [] (support.reset-state!)))

    (it "appends a user event as a transcript row"
      (fn []
        (ingest.append-event {:type :user :text "hello"})
        (assert.are.equal 1 (length state.transcript))
        (assert.are.equal :user (. state.transcript 1 :type))
        (assert.are.equal "hello" (. state.transcript 1 :text))))

    (it "merges assistant text deltas into a single streaming row"
      (fn []
        (ingest.append-event {:type :assistant-text-delta :content-index 0 :delta "Hel"})
        (ingest.append-event {:type :assistant-text-delta :content-index 0 :delta "lo"})
        (assert.are.equal 1 (length state.transcript))
        (let [row (. state.transcript 1)]
          (assert.are.equal "Hello" row.text)
          (assert.is_true row.streaming?))
        (ingest.append-event {:type :assistant-stream-end :final? true})
        (assert.is_nil (. state.transcript 1 :streaming?))
        (assert.is_true (. state.transcript 1 :final?))))

    (it "starts a new streaming row per content-index"
      (fn []
        (ingest.append-event {:type :assistant-thinking-delta :content-index 0 :delta "reason"})
        (ingest.append-event {:type :assistant-text-delta :content-index 1 :delta "answer"})
        (assert.are.equal 2 (length state.transcript))
        (assert.are.equal :assistant-thinking (. state.transcript 1 :type))
        (assert.are.equal :assistant-text (. state.transcript 2 :type))))

    (it "closes partial streaming output and shows cancelled state"
      (fn []
        (ingest.append-event {:type :assistant-text-delta :content-index 0 :delta "partial"})
        (ingest.append-event {:type :cancelling})
        (assert.is_true state.status-info.cancelling?)
        (ingest.append-event {:type :cancelled})
        (assert.is_false state.status-info.cancelling?)
        (assert.is_nil (. state.transcript 1 :streaming?))
        (assert.are.equal :cancelled (. state.transcript 2 :type))))

    (it "summarizes tool-call arguments and sets the running label"
      (fn []
        (ingest.append-event {:type :tool-call :name "read" :arguments {:path "/a.txt"}})
        (assert.are.equal "read" state.status-info.running-label)
        (let [row (. state.transcript 1)]
          (assert.are.equal :tool-call row.type)
          (assert.is_truthy (string.find row.args-pretty "a.txt" 1 true)))))

    (it "flattens tool-result content and clears the running label"
      (fn []
        (set state.status-info.running-label "read")
        (ingest.append-event {:type :tool-result :name "read"
                              :result {:content [{:type :text :text "file body"}]}})
        (assert.is_nil state.status-info.running-label)
        (assert.are.equal "file body" (. state.transcript 1 :body-pretty))))

    (it "folds set-status-info into the status model"
      (fn []
        (ingest.append-event {:type :set-status-info
                              :info {:provider "openai" :model "gpt-5" :steering-queued 2}})
        (assert.are.equal "openai" state.status-info.provider)
        (assert.are.equal "gpt-5" state.status-info.model)
        (assert.are.equal 2 state.status-info.steering-queued)))

    (it "tracks thinking/turn timing across llm-start and a final assistant message"
      (fn []
        (ingest.append-event {:type :llm-start})
        (assert.is_true state.status-info.thinking?)
        (assert.is_true (> state.status-info.turn-start 0))
        (ingest.append-event {:type :assistant-text :text "done" :final? true})
        (assert.is_false state.status-info.thinking?)
        (assert.are.equal 0 state.status-info.turn-start)))

    (it "accumulates all provider rounds in the current turn and cumulative totals"
      (fn []
        ;; One agent turn can make another provider round after a tool result.
        ;; The turn totals must keep the first round rather than showing only
        ;; the final round's usage.
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end
                              :usage {:input 1200 :output 400
                                      :cache-read 80 :cache-write 20}})
        (ingest.append-event {:type :tool-call :name "read"
                              :arguments {:path "/tmp/a"}})
        (ingest.append-event {:type :tool-result :name "read"
                              :result {:content [{:type :text :text "ok"}]}})
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end
                              :usage {:input 300 :output 100
                                      :cache-read 30 :cache-write 4}})
        (assert.are.equal 1500 state.status-info.cum-input)
        (assert.are.equal 500 state.status-info.cum-output)
        (assert.are.equal 110 state.status-info.cum-cache-read)
        (assert.are.equal 24 state.status-info.cum-cache-write)
        (assert.are.equal 1500 state.status-info.turn-input)
        (assert.are.equal 500 state.status-info.turn-output)
        (assert.are.equal 110 state.status-info.turn-cache-read)
        (assert.are.equal 24 state.status-info.turn-cache-write)
        (assert.is_true state.status-info.turn-usage?)
        (assert.are.equal 300 state.status-info.last-input)
        (assert.are.equal 100 state.status-info.last-output)
        (assert.are.equal 30 state.status-info.last-cache-read)
        (assert.are.equal 4 state.status-info.last-cache-write)
        (assert.is_true state.status-info.last-usage?)))

    (it "resets per-turn totals at the next turn while retaining cumulative totals"
      (fn []
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end
                              :usage {:input 1200 :output 400}})
        (ingest.append-event {:type :assistant-text :text "done" :final? true})
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end
                              :usage {:input 300 :output 100}})
        (assert.are.equal 1500 state.status-info.cum-input)
        (assert.are.equal 500 state.status-info.cum-output)
        (assert.are.equal 300 state.status-info.turn-input)
        (assert.are.equal 100 state.status-info.turn-output)))

    (it "resets cumulative token totals on :reset-conversation (/new, switch)"
      (fn []
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end
                              :usage {:input 1200 :output 400}})
        (assert.are.equal 1200 state.status-info.cum-input)
        (ingest.append-event {:type :reset-conversation})
        (assert.are.equal 0 state.status-info.cum-input)
        (assert.are.equal 0 state.status-info.cum-output)
        (assert.are.equal 0 state.status-info.turn-input)
        (assert.is_false state.status-info.usage-seen?)))

    (it "does not reuse or add stale usage when a round has no usage event"
      (fn []
        (ingest.append-event {:type :llm-end
                              :usage {:input 900 :output 90}})
        (ingest.append-event {:type :llm-start})
        (ingest.append-event {:type :llm-end})
        (assert.are.equal 900 state.status-info.cum-input)
        (assert.are.equal 90 state.status-info.cum-output)
        (assert.are.equal 0 state.status-info.last-output)
        (assert.is_false state.status-info.last-usage?)))

    (it "ignores redraw events (presenter control, no transcript row)"
      (fn []
        (ingest.append-event {:type :redraw})
        (assert.are.equal 0 (length state.transcript))))))
