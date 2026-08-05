;; Busted spec for fen.util.http.backends.fetch against a fake
;; __fen_host table (no real wasmoon/JS bridge — that's the runtime
;; package's job). Exercises: cooperative-mode polling/dispose, the
;; blocking-mode (no opts.yield) guard, default-timeout translation, and
;; accumulate-body? false passing the host's already-capped body through
;; unmodified.

(fn make-fake-host [poll-sequence]
  "poll-sequence: a list of tables returned by fetch_poll, one per call,
   in order. Records fetch_start's translated opts and fetch_dispose
   calls for assertions."
  (let [state {:start-opts nil
               :poll-index 0
               :dispose-calls []}]
    {:fetch_start (fn [opts]
                    (set state.start-opts opts)
                    1)
     :fetch_poll (fn [_id]
                   (set state.poll-index (+ state.poll-index 1))
                   (let [p (. poll-sequence state.poll-index)]
                     (assert p "poll-sequence exhausted")
                     p))
     :fetch_dispose (fn [id]
                      (table.insert state.dispose-calls id))
     :_state state}))

(describe "fen.util.http.backends.fetch"
  (fn []
    (it "cooperative mode: delivers chunks via on-chunk, yields between polls, disposes on completion"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              host (make-fake-host
                     [{:chunks ["a" "b"] :done false}
                      {:chunks ["c"] :done true :status 200 :headers {:x "1"} :body "abc"}])
              received []
              yield-count [0]]
          (set _G.__fen_host host)
          (let [result (fetch.request
                         {:method "GET"
                          :url "https://example.com"
                          :on-chunk (fn [chunk] (table.insert received chunk))
                          :yield (fn [] (tset yield-count 1 (+ (. yield-count 1) 1)))})]
            (assert.are.same ["a" "b" "c"] received)
            (assert.are.equal 200 result.status)
            (assert.are.equal "abc" result.body)
            (assert.are.same {:x "1"} result.headers)
            (assert.is_true (> (. yield-count 1) 0) "expected at least one yield")
            (assert.are.same [1] host._state.dispose-calls)))
        (set _G.__fen_host nil)))

    (it "blocking mode (no opts.yield) errors clearly instead of hanging"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              host (make-fake-host [{:chunks [] :done true :status 200 :headers {} :body ""}])]
          (set _G.__fen_host host)
          (let [(ok? err) (pcall fetch.request {:method "GET" :url "https://example.com"})]
            (assert.is_false ok?)
            (assert.is_string err)
            (assert.is_truthy (string.find err "cooperative mode" 1 true)))
          (set _G.__fen_host nil))))

    (it "applies fen's default timeouts when the caller doesn't set them"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              host (make-fake-host [{:chunks [] :done true :status 200 :headers {} :body ""}])]
          (set _G.__fen_host host)
          (fetch.request {:method "GET" :url "https://example.com" :yield (fn [])})
          (assert.are.equal 600000 host._state.start-opts.timeoutMs)
          (assert.are.equal 30000 host._state.start-opts.connectTimeoutMs)
          (assert.are.equal 60000 host._state.start-opts.idleTimeoutMs)
          (set _G.__fen_host nil))))

    (it "honors caller-supplied timeouts over the defaults"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              host (make-fake-host [{:chunks [] :done true :status 200 :headers {} :body ""}])]
          (set _G.__fen_host host)
          (fetch.request {:method "GET"
                           :url "https://example.com"
                           :timeout-ms 111
                           :connect-timeout-ms 222
                           :idle-timeout-ms 333
                           :yield (fn [])})
          (assert.are.equal 111 host._state.start-opts.timeoutMs)
          (assert.are.equal 222 host._state.start-opts.connectTimeoutMs)
          (assert.are.equal 333 host._state.start-opts.idleTimeoutMs)
          (set _G.__fen_host nil))))

    (it "accumulate-body? false passes the host's bounded body through unmodified"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              ;; Host already caps the body per its own ACCUMULATE_BODY_CAP
              ;; policy; the backend must return exactly that, not
              ;; table.concat the streamed chunks (which would exceed the
              ;; cap and defeat the point).
              host (make-fake-host
                     [{:chunks ["a" "b" "c"] :done true :status 200 :headers {} :body "a"}])]
          (set _G.__fen_host host)
          (let [result (fetch.request {:method "GET"
                                        :url "https://example.com"
                                        :accumulate-body? false
                                        :yield (fn [])})]
            (assert.are.equal "a" result.body)
            (assert.are.equal false host._state.start-opts.accumulateBody))
          (set _G.__fen_host nil))))

    (it "surfaces {:error} without a status when the host reports one"
      (fn []
        (let [fetch (require :fen.util.http.backends.fetch)
              host (make-fake-host [{:chunks [] :done true :error "timeout"}])]
          (set _G.__fen_host host)
          (let [result (fetch.request {:method "GET" :url "https://example.com" :yield (fn [])})]
            (assert.are.equal "timeout" result.error)
            (assert.is_nil result.status))
          (set _G.__fen_host nil))))))
