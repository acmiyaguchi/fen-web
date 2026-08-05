;; Tests for fen_web.sessions.kv_session against a table-backed host.kv
;; stub (packages/platform/tests/support.fnl), mirroring
;; fen/extensions/adapters/session-backends/jsonl/tests/session_test.fnl's
;; coverage: open/append/close/load round-trip, open-existing on a
;; missing session, list/latest ordering, find resolution, plus
;; kv-specific coverage from the fix-first review: latest-extension-state,
;; :path on handles (session_control.fnl's json-encode-failure guard),
;; create/doctor, deterministic same-timestamp index ordering, and the
;; cross-tab re-read-before-append guard.

(local support (require :support))
(local json (require :fen.util.json))
(local kv-session (require :fen_web.sessions.kv_session))
(local sessions-init (require :fen_web.sessions))

(fn user-message [text]
  {:role :user :content text})

(fn assistant-message [text]
  {:role :assistant :content text})

(describe "fen_web.sessions.kv_session"
  (fn []
    (var kv nil)
    (var backend nil)

    (before_each
      (fn []
        (set kv (support.make-kv))
        (set backend (kv-session.new kv))))

    (it "does not write to kv on open; append lazily creates meta + first entry"
      (fn []
        (let [s (backend.open "/some/cwd")]
          (assert.is_table s)
          (assert.is_string s.id)
          (assert.is_nil (kv.get (.. "session:" s.id ":meta")))
          (backend.append s (user-message "hi"))
          (assert.is_not_nil (kv.get (.. "session:" s.id ":meta")))
          (backend.close s))))

    (it "round-trips message order and shapes through append/close/load"
      (fn []
        (let [s (backend.open "/proj")]
          (backend.append s (user-message "hello"))
          (backend.append s (assistant-message "hi there"))
          (backend.append s (user-message "how are you"))
          (backend.close s)
          (let [messages (backend.load s.id)]
            (assert.are.equal 3 (length messages))
            (assert.are.equal :user (. messages 1 :role))
            (assert.are.equal "hello" (. messages 1 :content))
            (assert.are.equal :assistant (. messages 2 :role))
            (assert.are.equal "hi there" (. messages 2 :content))
            (assert.are.equal :user (. messages 3 :role))
            (assert.are.equal "how are you" (. messages 3 :content))))))

    (it "stores one kv key per entry, zero-padded and prefix-scannable"
      (fn []
        (let [s (backend.open "/proj")]
          (backend.append s (user-message "one"))
          (backend.append s (user-message "two"))
          (backend.close s)
          (let [keys (kv.list (.. "session:" s.id ":entry:"))]
            (assert.are.equal 2 (length keys))
            (assert.are.equal (.. "session:" s.id ":entry:00000001") (. keys 1))
            (assert.are.equal (.. "session:" s.id ":entry:00000002") (. keys 2))))))

    (it "chains parent-id across appends when not supplied"
      (fn []
        (let [s (backend.open "/proj")
              e1 (backend.append-entry s {:type :message :message (user-message "a")})
              e2 (backend.append-entry s {:type :message :message (user-message "b")})]
          (assert.is_nil e1.parent-id)
          (assert.are.equal e1.id e2.parent-id))))

    (it "open-existing resumes an open session preserving id/cwd and appends more entries"
      (fn []
        (let [s (backend.open "/proj" {:id "sid-1"})]
          (backend.append s (user-message "first"))
          (backend.close s)
          (let [resumed (backend.open-existing "sid-1")]
            (assert.is_table resumed)
            (assert.are.equal "sid-1" resumed.id)
            (assert.are.equal "/proj" resumed.cwd)
            (backend.append resumed (user-message "second"))
            (backend.close resumed)
            (let [messages (backend.load "sid-1")]
              (assert.are.equal 2 (length messages))
              (assert.are.equal "second" (. messages 2 :content)))))))

    (it "open-existing errors-like the reference by returning nil for a missing session"
      (fn []
        (assert.is_nil (backend.open-existing "does-not-exist"))))

    (it "sets :path to the session id on both open and open-existing handles (review #2)"
      (fn []
        ;; session_control.fnl's session-info only routes a value through
        ;; backend.info when value.path is truthy; otherwise it copies the
        ;; raw handle -- including the kv table's function values -- into
        ;; the JSON-encoded session record. Every handle must carry :path.
        (let [s (backend.open "/proj" {:id "px"})]
          (assert.are.equal "px" s.path)
          (backend.append s (user-message "hi"))
          (backend.close s)
          (let [resumed (backend.open-existing "px")]
            (assert.are.equal "px" resumed.path)))))

    (it "list/latest order multiple sessions for a cwd newest first"
      (fn []
        (let [s1 (backend.open "/proj" {:id "s1" :timestamp "2024-01-01T00-00-00"})
              s2 (backend.open "/proj" {:id "s2" :timestamp "2024-01-02T00-00-00"})
              s3 (backend.open "/other" {:id "s3" :timestamp "2024-01-03T00-00-00"})]
          (backend.append s1 (user-message "one"))
          (backend.close s1)
          (backend.append s2 (user-message "two"))
          (backend.close s2)
          (backend.append s3 (user-message "three"))
          (backend.close s3)
          (let [listed (backend.list "/proj" 10)]
            (assert.are.equal 2 (length listed))
            (assert.are.equal "s2" (. listed 1 :id))
            (assert.are.equal "s1" (. listed 2 :id))
            (assert.are.equal "s2" (backend.latest "/proj"))))))

    (it "orders same-timestamp sessions deterministically via the index's monotonic seq (review #6)"
      (fn []
        ;; Both sessions share one ISO-second timestamp; only ensure-open!
        ;; call order (first append order here) should decide ordering.
        (let [s1 (backend.open "/proj" {:id "same-a" :timestamp "2024-06-01T00-00-00"})
              s2 (backend.open "/proj" {:id "same-b" :timestamp "2024-06-01T00-00-00"})]
          (backend.append s2 (user-message "b first"))
          (backend.close s2)
          (backend.append s1 (user-message "a second"))
          (backend.close s1)
          (let [listed (backend.list "/proj" 10)]
            (assert.are.equal 2 (length listed))
            (assert.are.equal "same-a" (. listed 1 :id))
            (assert.are.equal "same-b" (. listed 2 :id))))))

    (it "excludes header-only (0-message) sessions from latest"
      (fn []
        ;; open() is lazy and writes nothing until the first append, so
        ;; simulate a genuinely header-only session (meta present, 0
        ;; entries) the way `create` would leave one that never got a
        ;; turn, by writing meta directly instead of going through open.
        (kv.put "session:empty:meta"
                (json.encode {:id "empty" :cwd "/proj"
                              :timestamp "2024-01-01T00-00-00" :version 1
                              :count 0 :message-count 0}))
        (kv.put "session-index:--proj--:2024-01-01T00-00-00_0000000001_empty" "empty")
        (let [real (backend.open "/proj" {:id "real" :timestamp "2024-01-02T00-00-00"})]
          (backend.append real (user-message "hi"))
          (backend.close real)
          (assert.are.equal "real" (backend.latest "/proj"))
          ;; the header-only session is still listed, just not "latest"
          (let [listed (backend.list "/proj" 10)]
            (assert.are.equal 2 (length listed))))))

    (it "find resolves latest, numeric list index, exact id, and unique id prefix"
      (fn []
        (let [s1 (backend.open "/proj" {:id "abc123" :timestamp "2024-01-01T00-00-00"})
              s2 (backend.open "/proj" {:id "def456" :timestamp "2024-01-02T00-00-00"})]
          (backend.append s1 (user-message "one"))
          (backend.close s1)
          (backend.append s2 (user-message "two"))
          (backend.close s2)
          (assert.are.equal "def456" (backend.find "/proj" nil))
          (assert.are.equal "def456" (backend.find "/proj" "latest"))
          (assert.are.equal "def456" (backend.find "/proj" "0"))
          (assert.are.equal "abc123" (backend.find "/proj" "1"))
          (assert.are.equal "abc123" (backend.find "/proj" "abc123"))
          (assert.are.equal "abc123" (backend.find "/proj" "abc")))))

    (it "find returns nil for an ambiguous or unknown target"
      (fn []
        (let [s (backend.open "/proj" {:id "zzz"})]
          (backend.append s (user-message "hi"))
          (backend.close s)
          (assert.is_nil (backend.find "/proj" "nope")))))

    (it "acquire-lock always succeeds and its release is a no-op callable"
      (fn []
        (let [release (backend.acquire-lock {:id "any"})]
          (assert.is_function release)
          (assert.has_no.errors (fn [] (release))))))

    (it "create durably writes meta immediately, unlike lazy open (review #3)"
      (fn []
        (let [s (backend.create "/proj")]
          (assert.is_string s.id)
          (assert.is_not_nil (kv.get (.. "session:" s.id ":meta")))
          (backend.close s)
          (let [found (backend.get "/proj" s.id)]
            (assert.are.equal s.id found.id)))))

    (it "doctor reports a clean session as ok with no issues (review #3)"
      (fn []
        (let [s (backend.open "/proj" {:id "healthy"})]
          (backend.append s (user-message "one"))
          (backend.append s (user-message "two"))
          (backend.close s)
          (let [report (backend.doctor "healthy")]
            (assert.is_true report.ok)
            (assert.are.equal 0 report.issue-count)))))

    (it "doctor flags a decode failure and a meta.count mismatch (review #3)"
      (fn []
        (let [s (backend.open "/proj" {:id "broken"})]
          (backend.append s (user-message "one"))
          (backend.close s)
          ;; Corrupt the entry payload directly, out from under the backend.
          (kv.put "session:broken:entry:00000001" "not json")
          (let [report (backend.doctor "broken")]
            (assert.is_true report.ok)
            (assert.is_true (> report.issue-count 0))))))

    (it "doctor errors like the reference for a missing session"
      (fn []
        (let [report (backend.doctor "does-not-exist")]
          (assert.is_false report.ok)
          (assert.is_string report.error))))

    (it "latest-extension-state returns nil when nothing was ever appended (review #1)"
      (fn []
        (let [s (backend.open "/proj" {:id "ext-empty"})]
          (backend.append s (user-message "hi"))
          (backend.close s)
          (assert.is_nil (backend.latest-extension-state s :goal-companion)))))

    (it "latest-extension-state returns the newest valid entry owned by extension (review #1)"
      (fn []
        (let [s (backend.open "/proj" {:id "ext-1"})]
          (backend.append-entry s {:type :extension-state :extension :goal-companion
                                   :version 1 :state {:goal "first"}})
          (backend.append-entry s {:type :extension-state :extension :other-ext
                                   :version 1 :state {:goal "not-mine"}})
          (backend.append-entry s {:type :extension-state :extension :goal-companion
                                   :version 1 :state {:goal "second"}})
          (backend.close s)
          (let [entry (backend.latest-extension-state s :goal-companion)]
            (assert.is_table entry)
            (assert.are.equal "second" entry.state.goal))))
      )

    (it "latest-extension-state honors ?accept and skips rejected entries (review #1)"
      (fn []
        (let [s (backend.open "/proj" {:id "ext-2"})]
          (backend.append-entry s {:type :extension-state :extension :goal-companion
                                   :version 1 :state {:goal "reject-me"}})
          (backend.append-entry s {:type :extension-state :extension :goal-companion
                                   :version 1 :state {:goal "accept-me"}})
          (backend.close s)
          (let [entry (backend.latest-extension-state
                        s :goal-companion nil
                        (fn [state] (= state.goal "accept-me")))]
            (assert.is_table entry)
            (assert.are.equal "accept-me" entry.state.goal)))))

    (it "latest-extension-state ignores malformed extension-state entries (review #1)"
      (fn []
        (let [s (backend.open "/proj" {:id "ext-3"})]
          (backend.append-entry s {:type :extension-state :extension :goal-companion
                                   ;; missing :version / :state -> malformed
                                   })
          (backend.close s)
          (assert.is_nil (backend.latest-extension-state s :goal-companion)))))

    (it "re-reads meta before assigning a sequence number so a stale second handle cannot overwrite (review #7)"
      (fn []
        (let [s (backend.open "/proj" {:id "shared"})]
          (backend.append s (user-message "from tab A"))
          (backend.close s)
          ;; Simulate a second tab's handle that opened before tab A's
          ;; append landed: same id, but stale in-memory count/last-entry-id.
          (let [stale-handle {:id "shared" :path "shared" :cwd "/proj"
                              :timestamp s.timestamp :kv kv
                              :count 0 :message-count 0 :last-entry-id nil
                              :header-written? true}]
            (backend.append stale-handle (user-message "from tab B"))
            (let [keys (kv.list "session:shared:entry:")]
              ;; Both entries must be present under distinct keys -- a
              ;; naive in-memory-count append would reuse seq 1 and clobber
              ;; tab A's entry.
              (assert.are.equal 2 (length keys)))
            (let [messages (backend.load "shared")]
              (assert.are.equal 2 (length messages))
              (assert.are.equal "from tab A" (. messages 1 :content))
              (assert.are.equal "from tab B" (. messages 2 :content)))))))))

(describe "fen_web.sessions (registration guard, review #4)"
  (fn []
    (var saved-host nil)

    (before_each (fn [] (set saved-host _G.__fen_host)))
    (after_each (fn [] (set _G.__fen_host saved-host)))

    (it "errors clearly when host.kv has not announced sync = true"
      (fn []
        (set _G.__fen_host {:kv (support.make-kv)}) ;; sync unset -> falsy
        (assert.has_error
          (fn [] (sessions-init.register {:register (fn [] nil)}))
          nil)))

    (it "registers successfully against a kv that announces sync = true"
      (fn []
        (let [kv (support.make-kv)]
          (set kv.sync true)
          (set _G.__fen_host {:kv kv})
          (var registered-name nil)
          (let [api {:register (fn [kind spec]
                                 (assert.are.equal :session-backend kind)
                                 (set registered-name spec.name)
                                 {:kind kind :name spec.name})}]
            (assert.has_no.errors (fn [] (sessions-init.register api)))
            (assert.are.equal :kv registered-name)))))))
