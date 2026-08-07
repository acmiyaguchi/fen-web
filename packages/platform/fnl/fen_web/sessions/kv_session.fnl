;; KV-backed session backend storage, over the synchronous host.kv seam
;; documented at docs/bindings/kv.md: {:get :put :delete :list}. Mirrors
;; fen/extensions/adapters/session-backends/jsonl/session.fnl's entry
;; shapes and open/append/load/find/list/latest semantics; only the
;; storage substrate differs (kv keys instead of a JSONL file).
;;
;; Storage scheme (deviations from the JSONL reference are forced by kv
;; being a flat, directory-less, mtime-less table):
;;
;;   "session:<id>:meta"           -> JSON {:id :cwd :timestamp :version
;;                                           :count :message-count
;;                                           :last-entry-id
;;                                           :title-user :title-fallback}
;;   "session:<id>:entry:<seq>"    -> JSON entry, seq zero-padded to 8
;;                                     digits so kv.list's lexicographic
;;                                     order is append order (kv has no
;;                                     numeric sort or directory listing).
;;   "session-index:<slug>:<ts>_<seq>_<id>" -> id
;;     Secondary index so list/latest/find can enumerate one cwd's
;;     sessions without a "session:" prefix scan of every entry key. Since
;;     kv has no mtime, recency here is the ISO timestamp baked into the
;;     index key (same "!%Y-%m-%dT%H-%M-%S" shape the jsonl backend uses
;;     for its filenames, which sorts lexicographically) rather than
;;     filesystem mtime. `<seq>` is a zero-padded process-local monotonic
;;     counter breaking ties deterministically when two sessions open
;;     within the same wall-clock second.
;;
;; meta carries :message-count and :title-user/:title-fallback (the first
;; user-role and first non-user-role message text seen so far, mirroring
;; the jsonl backend's scan-metadata title preference) so list/find/latest
;; can build a SessionInfo record straight from one meta `get` instead of
;; decoding every entry of every candidate session — the jsonl backend
;; gets this for free from filesystem mtime + a cached full-file scan;
;; kv has neither, so the title/count fields are maintained incrementally
;; on every append instead.
;;
;; `:path` on every returned SessionInfo/handle is the opaque session id,
;; not a filesystem path. session_control.fnl only routes a session value
;; through backend.info when `value.path` is truthy (else it copies the
;; raw handle, including the kv table itself, straight into `session-info`
;; -> a JSON-encode failure) — both make-open and make-open-existing set
;; `:path` for exactly this reason.
;;
;; Cross-tab safety: kv is origin-scoped, so two tabs can share one
;; session id. append-entry re-reads meta from kv immediately before
;; computing the next entry sequence number rather than trusting the
;; in-memory handle, so a second tab's append still lands on the next
;; free slot instead of silently overwriting the first tab's entry. This
;; is a best-effort interleaving guard, not a real lock — acquire-lock
;; below stays a trivial no-op per the sessions doc's "single-page
;; context, no concurrent processes" framing; a real cross-tab lock is a
;; separate concern (e.g. a Web Locks API binding) if it's ever needed.
;;
;; This module takes `kv` as an explicit argument on every function
;; (`new [kv]` returns the bound method table) rather than reading a
;; global, so Busted can inject a plain table-backed stub. The real
;; browser `host.kv` (IndexedDbKv) is async; bridging that onto this
;; synchronous seam — resuming the Lua coroutine once the kv promise
;; settles, or a start/poll pair mirroring fetch.fnl's FetchPoller — is a
;; packages/runtime concern for later, not this module's. init.fnl's
;; registration refuses to bind against a kv that hasn't announced
;; `:sync true`, so a raw async host.kv fails loudly at register time
;; instead of this module silently treating pending promises as strings.

(local json (require :fen.util.json))
(local log (require :fen.util.log))

(local M {})

(local VERSION 1)
(local ENTRY-SEQ-DIGITS 8)
(local INDEX-SEQ-DIGITS 10)

(fn encode [v] (json.encode v))
(fn decode [s] (json.decode s))

(fn warn! [msg]
  (let [(ok? _) (pcall log.warn msg)]
    (when (not ok?) (io.stderr:write (.. "[warn] " (tostring msg) "\n")))))

(fn iso-timestamp []
  (os.date "!%Y-%m-%dT%H-%M-%S"))

(var seed-done? false)
(fn ensure-seed! []
  (when (not seed-done?)
    (set seed-done? true)
    (math.randomseed (+ (os.time) (math.floor (* 1000 (or (os.clock) 0)))))))

(var counter 0)
(fn random-id []
  "Small locally-unique id: not a real UUID, just distinct-enough for a
   single-page kv-backed session store (mirrors the triviality the
   sessions doc calls out for locking in this context)."
  (ensure-seed!)
  (set counter (+ counter 1))
  (string.format "%x-%x-%x" (os.time) counter (math.random 0 0xffffff)))

(var open-seq 0)
(fn next-open-seq! []
  (set open-seq (+ open-seq 1))
  open-seq)

(fn cwd-slug [cwd]
  "Mirror the jsonl backend's `--<encoded-cwd>--` slug so both backends'
   docs/discussions of cwd-scoping stay comparable."
  (let [trimmed (string.gsub (or cwd "") "^/" "")
        dashed (string.gsub trimmed "/" "-")]
    (.. "--" dashed "--")))

(fn meta-key [id] (.. "session:" id ":meta"))
(fn entry-prefix [id] (.. "session:" id ":entry:"))
(fn entry-key [id seq]
  (.. (entry-prefix id) (string.format (.. "%0" ENTRY-SEQ-DIGITS "d") seq)))
(fn index-prefix [slug] (.. "session-index:" slug ":"))
(fn index-key [slug ts seq id]
  (.. (index-prefix slug) ts "_"
      (string.format (.. "%0" INDEX-SEQ-DIGITS "d") seq) "_" id))

(fn read-meta [kv id]
  (let [raw (kv.get (meta-key id))]
    (when raw
      (let [(ok? v) (pcall decode raw)]
        (if (and ok? (= (type v) :table))
            v
            (do
              (when (not ok?)
                (warn! (.. "session: malformed meta for " id)))
              nil))))))

(fn write-meta! [kv meta]
  (kv.put (meta-key meta.id) (encode meta)))

(fn read-entries [kv id ?yield-fn]
  "Return this session's entries in append order, skipping and warning on
   any key whose value fails to decode (mirrors the jsonl backend's
   skip-malformed-line behavior in read-entries)."
  (let [keys (kv.list (entry-prefix id))
        out []]
    (each [_ k (ipairs (or keys []))]
      (let [raw (kv.get k)]
        (if (not raw)
            (warn! (.. "session: missing value for " k))
            (let [(ok? entry) (pcall decode raw)]
              (if (and ok? (= (type entry) :table))
                  (table.insert out entry)
                  (warn! (.. "session: skipping malformed entry " k))))))
      (when ?yield-fn (?yield-fn)))
    out))

(fn clone-message-for-storage [msg]
  (let [out {}]
    (each [k v (pairs msg)]
      (when (not= (string.sub (tostring k) 1 2) "__")
        (tset out k v)))
    out))

(fn first-text [msg]
  (if (= (type (?. msg :content)) :string)
      msg.content
      (= (type (?. msg :content)) :table)
      (let [parts []]
        (each [_ block (ipairs msg.content)]
          (when (and (= (?. block :type) :text) block.text)
            (table.insert parts block.text)))
        (when (> (length parts) 0) (table.concat parts " ")))))

;; ----------------------------------------------------------------
;; open / append / close
;; ----------------------------------------------------------------

(fn make-open [kv]
  (fn [cwd ?opts]
    "Allocate a session id/timestamp for cwd without writing anything to
     kv yet. meta + the first entry are written lazily on first append,
     mirroring the jsonl backend's avoidance of header-only 0-message
     sessions."
    (let [ts (or (?. ?opts :timestamp) (iso-timestamp))
          id (or (?. ?opts :id) (random-id))]
      {:id id
       :path id
       :cwd cwd
       :timestamp ts
       :kv kv
       :count 0
       :message-count 0
       :last-entry-id nil
       :header-written? false})))

(fn ensure-open! [handle]
  (when (not handle.header-written?)
    (write-meta! handle.kv {:id handle.id :cwd handle.cwd
                             :timestamp handle.timestamp :version VERSION
                             :count 0 :message-count 0 :last-entry-id nil
                             :title-user nil :title-fallback nil})
    (handle.kv.put (index-key (cwd-slug handle.cwd) handle.timestamp
                               (next-open-seq!) handle.id)
                    handle.id)
    (set handle.header-written? true))
  true)

(fn make-append-entry [kv]
  (fn [handle entry]
    "Append one entry, filling :id/:parent-id/:timestamp when absent, same
     contract as fen's append-entry-based backends. Re-reads meta from kv
     immediately before assigning the next sequence number/parent-id so a
     second tab's append lands after this one instead of overwriting it."
    (when (and handle entry entry.type (ensure-open! handle))
      (let [out {}]
        (each [k v (pairs entry)] (tset out k v))
        (let [persisted (or (read-meta kv handle.id)
                             {:id handle.id :cwd handle.cwd
                              :timestamp handle.timestamp :version VERSION
                              :count handle.count
                              :message-count handle.message-count
                              :last-entry-id handle.last-entry-id})]
          (when (not out.id) (set out.id (random-id)))
          (when (and (= (. out :parent-id) nil) persisted.last-entry-id)
            (tset out :parent-id persisted.last-entry-id))
          (when (not out.timestamp) (set out.timestamp (iso-timestamp)))
          (let [seq (+ (or persisted.count 0) 1)]
           (var message-count (or persisted.message-count 0))
           (var title-user persisted.title-user)
           (var title-fallback persisted.title-fallback)
            (kv.put (entry-key handle.id seq) (encode out))
            (when (and (= out.type :message) (= (type out.message) :table))
              (set message-count (+ message-count 1))
              (when (not title-user)
                (let [text (first-text out.message)]
                  (when text
                    (if (= out.message.role :user)
                        (set title-user text)
                        (when (not title-fallback) (set title-fallback text)))))))
            (set handle.count seq)
            (set handle.last-entry-id out.id)
            (set handle.message-count message-count)
            (write-meta! kv {:id handle.id :cwd handle.cwd
                              :timestamp handle.timestamp :version VERSION
                              :count seq :last-entry-id out.id
                              :message-count message-count
                              :title-user title-user
                              :title-fallback title-fallback})))
        out))))

(fn make-append [kv]
  (let [append-entry (make-append-entry kv)]
    (fn [handle msg]
      (let [entry (append-entry handle {:type :message
                                        :message (clone-message-for-storage msg)})]
        (when (and entry msg)
          (tset msg :__session-entry-id entry.id))
        entry))))

(fn make-create [kv]
  (let [open (make-open kv)]
    (fn [cwd]
      "Durably create a header-only session (meta + index written
       immediately), unlike the lazy `open`. Mirrors the jsonl backend's
       `create`, used by `fen session new`."
      (let [handle (open cwd)]
        (ensure-open! handle)
        handle))))

(fn M.close [handle]
  ;; kv.put is synchronous, so there is no buffered handle to flush; this
  ;; exists to satisfy the session-backend contract's `close` method and
  ;; to mark the handle done for callers that check it.
  (when handle
    (set handle.closed? true))
  nil)

;; ----------------------------------------------------------------
;; load / replay
;; ----------------------------------------------------------------

(fn message-entries [entries]
  (let [out []]
    (each [_ entry (ipairs entries)]
      (when (and (= entry.type :message) entry.message)
        (tset entry.message :__session-entry-id entry.id)
        (table.insert out entry)))
    out))

(fn latest-valid-compaction [entries messages]
  (var found nil)
  (each [_ entry (ipairs entries)]
    (when (= entry.type :compaction)
      (if (or (not entry.summary) (not entry.first-kept-entry-id))
          (warn! "session: ignoring malformed compaction entry")
          (do
            (var idx nil)
            (each [i m-entry (ipairs messages)]
              (when (= m-entry.id entry.first-kept-entry-id)
                (set idx i)))
            (if idx
                (set found {:entry entry :index idx})
                (warn! "session: ignoring compaction with unresolved first-kept-entry-id"))))))
  found)

(fn compaction-summary-message [entry]
  {:role :user
   :content (.. "Compaction summary of earlier fen session context. Use this as context for the continuing conversation; do not ask me to restate it.\n\n"
                entry.summary)
   :timestamp (os.time)
   :__compaction-entry-id entry.id})

(fn make-load [kv]
  (fn [ref ?yield-fn]
    "Return replayable canonical messages for session id, applying the
     latest valid :compaction entry when present (same semantics as the
     jsonl backend's `load`)."
    (let [id (if (= (type ref) :table) ref.id ref)
          entries (read-entries kv id ?yield-fn)
          msg-entries (message-entries entries)
          compact (latest-valid-compaction entries msg-entries)
          out []]
      (if compact
          (do
            (table.insert out (compaction-summary-message compact.entry))
            (for [i compact.index (length msg-entries)]
              (table.insert out (. msg-entries i :message))))
          (each [_ entry (ipairs msg-entries)]
            (table.insert out entry.message)))
      out)))

;; ----------------------------------------------------------------
;; extension state
;; ----------------------------------------------------------------

(fn valid-extension-state-entry? [entry extension]
  (and (= entry.type :extension-state)
       entry.extension
       (= (tostring entry.extension) (tostring extension))
       (= (type entry.version) :number)
       (= entry.version (math.floor entry.version))
       (>= entry.version 1)
       (= (type entry.state) :table)))

(fn make-latest-extension-state [kv]
  (fn [handle extension ?yield-fn ?accept]
    "Return the latest valid :extension-state entry owned by `extension`
     for this session, mirroring the jsonl backend's
     latest-extension-state (session_backend.fnl's optional method) --
     without it, extension-owned state written via append-entry is
     silently unreadable on resume."
    (let [id (if (= (type handle) :table) handle.id handle)
          entries (read-entries kv id ?yield-fn)]
      (var found nil)
      (each [_ entry (ipairs entries)]
        (if (= entry.type :extension-state)
            (if (not (valid-extension-state-entry? entry extension))
                (when (= (tostring entry.extension) (tostring extension))
                  (warn! "session: ignoring malformed extension-state entry"))
                (if (or (not ?accept) (?accept entry.state entry))
                    (set found entry)
                    (warn! "session: ignoring rejected extension-state entry")))))
      found)))

;; ----------------------------------------------------------------
;; discovery: list / latest / find / get / open-existing
;; ----------------------------------------------------------------

(fn short-title [s]
  (when s
    (let [one-line (string.gsub s "%s+" " ")]
      (if (> (length one-line) 80)
          (.. (string.sub one-line 1 77) "...")
          one-line))))

(fn session-record [kv id]
  "Build a SessionInfo straight from meta -- no entry decoding needed,
   since append keeps :message-count/:title-user/:title-fallback current.
   Falls back to a bare record if meta is missing/unreadable."
  (let [meta (or (read-meta kv id) {:id id})]
    {:path id
     :id id
     :cwd meta.cwd
     :timestamp meta.timestamp
     :title (short-title (or meta.title-user meta.title-fallback))
     :message-count (or meta.message-count 0)
     :version meta.version}))

(fn ids-for-cwd-newest-first [kv cwd]
  (let [slug (cwd-slug cwd)
        keys (kv.list (index-prefix slug))
        out []]
    ;; kv.list is ascending lexicographic; index keys are
    ;; "<ts>_<seq>_<id>" so ascending == oldest first, hence the reverse.
    (for [i (length (or keys [])) 1 -1]
      (let [k (. keys i)
            id (kv.get k)]
        (table.insert out (or id (string.match k "_([^_]+)$")))))
    out))

(fn make-list [kv]
  (fn [cwd limit ?yield-fn]
    (let [max-count (or limit 20)
          out []]
      (each [_ id (ipairs (ids-for-cwd-newest-first kv cwd)) &until (>= (length out) max-count)]
        (table.insert out (session-record kv id))
        (when ?yield-fn (?yield-fn)))
      out)))

(fn make-latest [kv]
  (fn [cwd ?yield-fn]
    "Return the newest non-empty session id for cwd. Reads only meta per
     candidate (no entry decoding) via session-record's meta-only path."
    (var found nil)
    (each [_ id (ipairs (ids-for-cwd-newest-first kv cwd)) &until found]
      (let [meta (read-meta kv id)]
        (when (and meta (> (or meta.message-count 0) 0))
          (set found id)))
      (when ?yield-fn (?yield-fn)))
    found))

(fn make-get [kv]
  (fn [cwd target ?yield-fn]
    (var found nil)
    (var ambiguous? false)
    (each [_ id (ipairs (ids-for-cwd-newest-first kv cwd))]
      (when (= (tostring id) (tostring target))
        (if found (set ambiguous? true) (set found (session-record kv id)))))
    (when ?yield-fn (?yield-fn))
    (if ambiguous? (values nil :ambiguous) found)))

(fn make-find [kv]
  (let [list (make-list kv)
        latest (make-latest kv)]
    (fn [cwd target ?yield-fn]
      "Resolve a resume target for cwd: nil/latest, a 0-based
       reverse-chronological list index, an exact id, or a unique id
       prefix — mirrors the jsonl backend's `find`, minus path-literal
       resolution (kv sessions have no filesystem path)."
      (let [t (or target :latest)]
        (if (or (= t "") (= t :latest) (= t "latest"))
            (latest cwd ?yield-fn)
            (let [idx (tonumber t)
                  sessions (list cwd 200 ?yield-fn)]
              (if (and idx (>= idx 0) (< idx (length sessions)))
                  (. sessions (+ idx 1) :path)
                  (let [matches []]
                    (each [_ rec (ipairs sessions)]
                      (when (or (= rec.id t)
                                (and rec.id (= (string.sub rec.id 1 (length t)) t)))
                        (table.insert matches rec.path)))
                    (if (= (length matches) 1) (. matches 1) nil)))))))))

(fn make-open-existing [kv]
  (fn [ref ?yield-fn]
    (let [meta (read-meta kv ref)]
      (when ?yield-fn (?yield-fn))
      (when meta
        {:id meta.id
         :path meta.id
         :cwd meta.cwd
         :timestamp meta.timestamp
         :kv kv
         :count (or meta.count 0)
         :message-count (or meta.message-count 0)
         :last-entry-id meta.last-entry-id
         :header-written? true}))))

;; ----------------------------------------------------------------
;; delete
;; ----------------------------------------------------------------

(fn make-delete [kv]
  (fn [ref]
    "Delete a session's metadata, entries, and secondary index records.
    The index is scanned by value rather than reconstructed from cwd so this
    also removes stale records left by an interrupted write or old metadata."
    (let [id (if (= (type ref) :table) ref.id ref)
          id (and id (tostring id))
          meta (and id (read-meta kv id))]
      (when id
        (each [_ k (ipairs (or (kv.list (entry-prefix id)) []))]
          (kv.delete k))
        (each [_ k (ipairs (or (kv.list "session-index:") []))]
          (when (= (tostring (kv.get k)) id)
            (kv.delete k)))
        (kv.delete (meta-key id)))
      (not= meta nil))))

;; ----------------------------------------------------------------
;; doctor: cheap non-destructive integrity scan
;; ----------------------------------------------------------------

(fn make-doctor [kv]
  (fn [ref ?repair?]
    "Non-destructive integrity check: every entry key under the session
     decodes, and meta.count matches the number of entries actually
     found. No repair support (kv has nothing analogous to jsonl's
     sibling .repaired.jsonl file to write); ?repair? only flows through
     to the report's :repair? field."
    (let [id (if (= (type ref) :table) ref.id ref)
          meta (read-meta kv id)]
      (if (not meta)
          {:ok false :error (.. "cannot read session: " (tostring id))}
          (let [keys (kv.list (entry-prefix id))
                issues []]
            (var valid-count 0)
            (each [_ k (ipairs keys)]
              (let [raw (kv.get k)]
                (if (not raw)
                    (table.insert issues {:line 0 :code :missing_entry
                                          :message (.. "missing value for key " k)})
                    (let [(ok? entry) (pcall decode raw)]
                      (if (or (not ok?) (not= (type entry) :table))
                          (table.insert issues {:line 0 :code :malformed_json
                                                :message (.. "cannot decode " k)})
                          (set valid-count (+ valid-count 1)))))))
            (when (not= valid-count (or meta.count 0))
              (table.insert issues
                            {:line 0 :code :count_mismatch
                             :message (.. "meta.count=" (tostring (or meta.count 0))
                                          " but " (tostring valid-count)
                                          " entries decoded")}))
            {:ok true :path id :issues issues :issue-count (length issues)
             :repair? (= true ?repair?)})))))

;; ----------------------------------------------------------------
;; locking
;; ----------------------------------------------------------------

;; @doc fen_web.sessions.kv_session.acquire-lock
;; kind: function
;; signature: (acquire-lock info) -> release-fn
;; summary: Trivial single-page no-op lock: a page has no concurrent siblings mutating the same kv, so acquire always succeeds and release does nothing.
;; tags: session kv locking
(fn M.acquire-lock [info]
  (fn [] nil))

;; ----------------------------------------------------------------
;; construction
;; ----------------------------------------------------------------

;; @doc fen_web.sessions.kv_session.new
;; kind: function
;; signature: (new kv) -> backend-methods
;; summary: Bind the kv-backed session backend's methods to one synchronous host.kv table, returning open/open-existing/append/close/load/find/list/latest plus create/delete/doctor/get/acquire-lock/latest-extension-state.
;; tags: session kv backend
(fn M.new [kv]
  {:open (make-open kv)
   :open-existing (make-open-existing kv)
   :append (make-append kv)
   :append-entry (make-append-entry kv)
   :create (make-create kv)
   :close M.close
   :load (make-load kv)
   :find (make-find kv)
   :list (make-list kv)
   :latest (make-latest kv)
   :get (make-get kv)
   :delete (make-delete kv)
   :doctor (make-doctor kv)
   :acquire-lock M.acquire-lock
   :latest-extension-state (make-latest-extension-state kv)
   :info (fn [handle]
           (when handle
             {:backend :kv :id handle.id :path handle.path :cwd handle.cwd}))})

(set M.VERSION VERSION)
(set M.cwd-slug cwd-slug)

M
