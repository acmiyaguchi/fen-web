;; fs-kv: the remaining browser compatibility shim for fen's direct POSIX IO.
;;
;; fen v0.17 moved settings persistence behind fen.core.storage and
;; environment lookup behind fen.util.path. The browser runtime preloads those
;; seams directly, so this module is no longer needed by core/settings or
;; core/llm/models. Those modules do not justify global patches anymore.
;;
;; The web boot still loads fen's Codex provider in dev mode. Its auth-keychain
;; module directly uses os.getenv (HOME/XDG/FEN_AUTH_DIR), io.open (r/w),
;; os.rename/os.remove, and os.execute. browserBoot seeds auth.json into the
;; synchronous kv view at the env-less fallback path, so those operations
;; remain load-bearing there. fen.util.jsonl and provider diagnostics also use
;; append-mode IO. This shim therefore keeps the general synchronous file
;; behavior for those non-seamed web paths, but it is not the settings/models
;; fulfillment and the headless integration script does not install it.
;;
;; Production host.kv is exposed to Fennel synchronously by the runtime-side
;; cache/bridge. Busted uses the table-backed synchronous kv in support.fnl.
;; The shim must be installed only after Busted has loaded any Fennel modules
;; whose source the Busted searcher needs to read through the real io.open.

(local M {})

;; Binary mode has no special meaning for kv strings, matching the text
;; content behavior of the old shim while accepting real io.open's "b" suffix.
(fn strip-binary-suffix [mode]
  (if (string.match mode "b$")
      (string.sub mode 1 (- (length mode) 1))
      mode))

(fn unsupported-method [handle-name method-name]
  (fn [...]
    (error (.. "fs-kv: " handle-name ":" (tostring method-name)
               " is not supported by the kv-backed shim"))))

(fn with-unsupported-index [handle-name t]
  "Give unsupported FILE methods a diagnostic error instead of a nil-call crash."
  (setmetatable t {:__index (fn [_self key] (unsupported-method handle-name key))}))

(fn read-handle [content]
  (with-unsupported-index :read-handle
    {:read (fn [_self fmt]
             (let [f (or fmt :a)]
               (if (or (= f :a) (= f "*a") (= f :*a))
                   content
                   (error (.. "fs-kv: read format " (tostring f)
                              " is not supported by the kv-backed shim")))))
     :close (fn [_self] true)
     :flush (fn [_self] true)
     :lines (fn [_self]
              (var done false)
              (fn []
                (if done
                    nil
                    (do (set done true) content))))}))

(fn write-handle [kv path ?seed]
  "A write/append handle that buffers writes in memory and commits on close."
  (var buffer (or ?seed ""))
  (with-unsupported-index :write-handle
    {:write (fn [_self ...]
              (each [_ chunk (ipairs [...])]
                (set buffer (.. buffer (tostring chunk))))
              true)
     :flush (fn [_self]
              ;; kv.put only happens on close, so flush is a deliberate no-op.
              true)
     :close (fn [_self]
              (kv.put path buffer)
              true)}))

;; @doc fen_web.shims.fs-kv.open
;; kind: function
;; signature: (open kv path mode) -> (handle|nil, err?)
;; summary: kv-backed io.open replacement supporting "r" (missing key -> nil, err), "w" (buffered truncate), and "a" (buffered append). Binary suffixes are accepted; recognized update modes return nil, err and malformed modes error.
;; tags: shims kv fs io auth diagnostics
(fn M.open [kv path ?mode]
  (let [raw (or ?mode :r)
        mode (strip-binary-suffix (tostring raw))]
    (if (not (or (= mode "r") (= mode "w") (= mode "a")))
        (if (or (= mode "r+") (= mode "w+") (= mode "a+"))
            (values nil (.. path ": unsupported mode '" (tostring raw) "'"))
            (error (.. "fs-kv: invalid mode '" (tostring raw) "'")))
        (= mode "r")
        (let [content (kv.get path)]
          (if (= content nil)
              (values nil (.. path ": No such file or directory"))
              (values (read-handle content) nil)))
        (= mode "w")
        (values (write-handle kv path "") nil)
        (values (write-handle kv path (or (kv.get path) "")) nil))))

;; @doc fen_web.shims.fs-kv.remove
;; kind: function
;; signature: (remove kv path) -> true
;; summary: kv-backed os.remove replacement, retained for Codex auth temp-file cleanup.
;; tags: shims kv fs io auth
(fn M.remove [kv path]
  (kv.delete path)
  true)

;; @doc fen_web.shims.fs-kv.rename
;; kind: function
;; signature: (rename kv from to) -> (true|nil, err?)
;; summary: kv-backed os.rename replacement, retained for Codex auth atomic writes; copies the value under the new key and deletes the old one.
;; tags: shims kv fs io auth
(fn M.rename [kv from to]
  (let [content (kv.get from)]
    (if (= content nil)
        (values nil (.. from ": No such file or directory"))
        (do (kv.put to content)
            (kv.delete from)
            (values true nil)))))

;; @doc fen_web.shims.fs-kv.execute
;; kind: function
;; signature: (execute cmd) -> true, "exit", 0 | nil, "exit", 127
;; summary: kv-backed os.execute replacement. mkdir -p is a successful no-op over the flat kv namespace; other commands fail rather than pretending to run. Codex's chmod call is intentionally ignored by its caller.
;; tags: shims kv fs io auth diagnostics
(fn M.execute [cmd]
  (if (and cmd (string.match (tostring cmd) "^mkdir %-p"))
      (values true :exit 0)
      (values nil :exit 127)))

;; @doc fen_web.shims.fs-kv.install!
;; kind: function
;; signature: (install! kv) -> nil
;; summary: Install the direct POSIX IO compatibility operations still used by the web Codex auth keychain and optional diagnostics. Core settings/models use fen.core.storage.backend and fen.util.path.backend instead. Asserts the synchronous kv get/put/delete surface needed by the retained operations.
;; tags: shims kv fs io auth diagnostics bootstrap
(fn M.install! [kv]
  (assert (and kv (= (type kv.get) :function))
          "fs-kv: install! requires kv.get to be a function")
  (assert (= (type kv.put) :function)
          "fs-kv: install! requires kv.put to be a function")
  (assert (= (type kv.delete) :function)
          "fs-kv: install! requires kv.delete to be a function")
  (set io.open (fn [path ?mode] (M.open kv path ?mode)))
  (set os.remove (fn [path] (M.remove kv path)))
  (set os.rename (fn [from to] (M.rename kv from to)))
  (set os.execute (fn [?cmd] (M.execute ?cmd)))
  ;; Keep Codex's HOME/XDG/FEN_AUTH_DIR lookups on the env-less browser
  ;; fallback; API-key lookup uses fen.util.path.getenv instead.
  (set os.getenv (fn [_name] nil))
  nil)

;; @doc fen_web.shims.fs-kv.snapshot-globals
;; kind: function
;; signature: (snapshot-globals) -> table
;; summary: Capture the direct IO globals retained by install!, for uninstall! in tests.
;; tags: shims kv fs io auth diagnostics bootstrap test
(fn M.snapshot-globals []
  {:io-open io.open
   :os-remove os.remove
   :os-rename os.rename
   :os-execute os.execute
   :os-getenv os.getenv})

;; @doc fen_web.shims.fs-kv.uninstall!
;; kind: function
;; signature: (uninstall! snapshot) -> nil
;; summary: Restore the globals captured by snapshot-globals, undoing install! for tests.
;; tags: shims kv fs io auth diagnostics bootstrap test
(fn M.uninstall! [snapshot]
  (set io.open snapshot.io-open)
  (set os.remove snapshot.os-remove)
  (set os.rename snapshot.os-rename)
  (set os.execute snapshot.os-execute)
  (set os.getenv snapshot.os-getenv)
  nil)

M
