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

    (it "ignores redraw events (presenter control, no transcript row)"
      (fn []
        (ingest.append-event {:type :redraw})
        (assert.are.equal 0 (length state.transcript))))))
