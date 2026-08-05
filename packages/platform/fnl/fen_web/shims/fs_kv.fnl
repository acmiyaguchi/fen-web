;; fs-kv: `io.open`/`os.remove`/`os.rename`/`os.execute`/`os.getenv` shims
;; backed by `__fen_host.kv`, for fen#15
;; (https://github.com/acmiyaguchi/fen-web/issues/15).
;;
;; fen.core.settings (io.open, os.remove) and fen.core.llm.models (io.open
;; for models.json, os.getenv for apiKey env-var resolution) are hard
;; dependencies on real-OS globals, not registrable seams -- see
;; docs/architecture/seams.md's "What is not a seam" section and
;; docs/platform/shims.md. Rather than reimplementing either module (both
;; carry real business logic well past IO -- models.fnl alone is ~640
;; lines of provider/model resolution), this module monkey-patches the
;; five Lua globals those two files actually call, so both modules load
;; and run completely unmodified against `host.kv` and their public API
;; is preserved by construction.
;;
;; Blast radius: `install!` patches VM-wide globals, not just the two
;; modules issue #15 targets. Every fen module that touches io.open,
;; os.remove/rename/execute, or os.getenv is affected the moment it's
;; installed -- see docs/platform/shims.md's blast-radius table for the
;; concrete list (log_sink.fnl, jsonl.fnl, checksum.fnl, path.fnl's
;; HOME/XDG lookups, discover.fnl/reload.fnl/rocks.fnl's FEN_* lookups,
;; etc). That table is meant to be diffed against on every fen version
;; bump.
;;
;; Wasmoon's Lua 5.4 stdlib already provides working os.time/os.date/
;; os.clock (verified against packages/runtime's createFenRuntime with a
;; quick node probe -- these read a real wall clock inside the WASM
;; runtime, no OS syscalls needed), so this module intentionally does not
;; touch them.
;;
;; kv is the synchronous seam described in docs/bindings/kv.md /
;; docs/architecture/seams.md: `{:get (fn [key]) :put (fn [key value])
;; :delete (fn [key]) :list (fn [prefix])}`, get/put/delete returning
;; plain values (not promises) as Busted's table-backed kv does here.
;; Production `host.kv` is an async IndexedDB-backed store
;; (packages/bindings/src/kv/indexedDbKv.ts) -- bridging that async
;; surface into these synchronous Lua call sites (coroutine yield across
;; the C-call boundary, same hazard host-protocol.md documents for fetch)
;; is `packages/runtime`'s job at boot time, not this module's. This
;; module only assumes whatever kv table it's given answers synchronously,
;; which is exactly what a runtime-side coroutine-pumped wrapper would
;; hand it.
;;
;; Test-vs-production install-order note: Busted specs in this package
;; must `require` the real fen module (against the *real*, unpatched
;; io.open) before calling `install!` -- Busted's own Fennel searcher
;; reads .fnl source files off disk via io.open, so installing the shim
;; before the module is first loaded makes module *loading itself* try to
;; fetch the module's source out of the (empty) kv instead of the
;; filesystem. This is purely a Busted-searcher artifact: production
;; `packages/runtime` reads all Fennel sources through a JS-side
;; SourceLookup (see docs/runtime/boot.md), never through io.open, so
;; `install!` is safe to call before the very first `require` at real
;; boot time -- there is no equivalent ordering hazard there.

(local M {})

;; Recognized real io.open mode strings (a trailing "b" -- binary mode --
;; is accepted and stripped for all of them, matching real io.open, since
;; there's no text/binary distinction over a kv string value). Anything
;; outside this set is a malformed mode string, which real io.open also
;; rejects with a Lua error -- so we still error() there. Modes inside the
;; set that this shim doesn't implement (the `+` update modes) return
;; `nil, err` instead, since a real file's open() call for those can fail
;; for ordinary reasons (permissions, missing file) that callers already
;; treat as recoverable.
(local valid-modes {"r" true "w" true "a" true
                     "r+" true "w+" true "a+" true})

(fn strip-binary-suffix [mode]
  (if (string.match mode "b$")
      (string.sub mode 1 (- (length mode) 1))
      mode))

(fn unsupported-method [handle-name method-name]
  (fn [...]
    (error (.. "fs-kv: " handle-name ":" (tostring method-name)
               " is not supported by the kv-backed shim"))))

(fn with-unsupported-index [handle-name t]
  "Any method not explicitly defined on a shimmed file handle errors with
   a clear 'unsupported by fs_kv shim' message via __index, instead of
   Lua's default 'attempt to call a nil value' -- callers that probe for
   :seek/:setvbuf/etc get a diagnosable error instead of a confusing one."
  (setmetatable t {:__index (fn [_self key] (unsupported-method handle-name key))}))

(fn read-handle [content]
  "A read-only file handle wrapping an already-fetched kv value. Only
   the `*a`/`a` whole-file read fen's slurp helpers actually use is
   supported; anything else errors loudly rather than returning a
   silently wrong partial read."
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
  "A write/append file handle that buffers writes in memory and commits
   them to kv on :close. `?seed` is the buffer's starting content --
   \"\" for io.open(path, \"w\")'s create-or-truncate semantics, or the
   file's current kv value for \"a\" append semantics. By design, a
   reader that does kv.get(path) (or a fresh io.open(path, \"r\")) before
   this handle's :close sees nothing new -- the same 'buffered, not
   flushed to the underlying store until closed' behavior a real
   buffered FILE* has before its own flush/close."
  (var buffer (or ?seed ""))
  (with-unsupported-index :write-handle
    {:write (fn [_self ...]
              (each [_ chunk (ipairs [...])]
                (set buffer (.. buffer (tostring chunk))))
              true)
     :flush (fn [_self]
              ;; jsonl.fnl calls :flush after every record for
              ;; durability/visibility over a real FILE*. There's nothing
              ;; to flush to here -- kv.put only happens on :close -- so
              ;; this is a deliberate no-op, not a real flush; see the
              ;; write-then-read-before-close note above.
              true)
     :close (fn [_self]
              (kv.put path buffer)
              true)}))

;; @doc fen_web.shims.fs-kv.open
;; kind: function
;; signature: (open kv path mode) -> (handle|nil, err?)
;; summary: kv-backed io.open replacement supporting "r" (missing key -> nil, err), "w" (buffered write, committed on close), and "a" (buffered append, seeded from the current kv value). Recognized-but-unimplemented modes ("r+"/"w+"/"a+") return nil, err rather than throwing; unrecognized mode strings still error(), matching real io.open.
;; tags: shims kv fs io
(fn M.open [kv path ?mode]
  (let [raw (or ?mode :r)
        mode (strip-binary-suffix (tostring raw))]
    (if (not (. valid-modes mode))
        (error (.. "fs-kv: invalid mode '" (tostring raw) "'"))
        (= mode "r")
        (let [content (kv.get path)]
          (if (= content nil)
              (values nil (.. path ": No such file or directory"))
              (values (read-handle content) nil)))
        (= mode "w")
        (values (write-handle kv path "") nil)
        (= mode "a")
        (values (write-handle kv path (or (kv.get path) "")) nil)
        ;; r+/w+/a+: valid mode strings, not implemented by this shim.
        (values nil (.. path ": unsupported mode '" (tostring raw) "'")))))

;; @doc fen_web.shims.fs-kv.remove
;; kind: function
;; signature: (remove kv path) -> true
;; summary: kv-backed os.remove replacement; deleting an absent key is not an error, matching callers that remove best-effort temp files.
;; tags: shims kv fs io
(fn M.remove [kv path]
  (kv.delete path)
  true)

;; @doc fen_web.shims.fs-kv.rename
;; kind: function
;; signature: (rename kv from to) -> (true|nil, err?)
;; summary: kv-backed os.rename replacement for settings.fnl's atomic-write! temp-file dance -- copies the value under the new key and deletes the old one.
;; tags: shims kv fs io
(fn M.rename [kv from to]
  (let [content (kv.get from)]
    (if (= content nil)
        (values nil (.. from ": No such file or directory"))
        (do (kv.put to content)
            (kv.delete from)
            (values true nil)))))

;; @doc fen_web.shims.fs-kv.execute
;; kind: function
;; signature: (execute cmd) -> (true, "exit", 0)|(nil, "exit", 127)
;; summary: kv-backed os.execute replacement. Only settings.fnl's "mkdir -p <dir>" ensure-dir! call (meaningless over a flat kv namespace) reports success; any other command reports failure (exit 127, "command not found") rather than silently lying that it ran -- io.popen is intentionally left unpatched, so a caller shelling out for anything else fails loudly instead of getting a fake success for a command that did nothing.
;; tags: shims kv fs io
(fn M.execute [cmd]
  (if (and cmd (string.match (tostring cmd) "^mkdir %-p"))
      (values true :exit 0)
      (values nil :exit 127)))

;; API-key-shaped env var names this shim is willing to answer from kv:
;; upper-snake-case, ending in _KEY/_TOKEN/_SECRET or containing KEY as a
;; whole word segment (covers models.fnl's own convention plus common
;; provider env names like OPENAI_API_KEY/ANTHROPIC_API_KEY). Everything
;; else -- HOME, PATH, PWD, XDG_*, LUA, and every FEN_* debug/dev flag
;; (FEN_LOG, FEN_DEV_PATH, FEN_TOOL_RESULT_MAX_BYTES, FEN_ROCKS_TREE,
;; FEN_ARCH, FEN_BIN, FEN_EXTENSIONS_PATH,
;; FEN_FIRST_PARTY_EXTENSIONS_PATH) -- returns nil unconditionally,
;; regardless of what's in kv, so UI-writable kv content can never drive
;; those. See docs/platform/shims.md's blast-radius table for the full
;; enumeration this was checked against.
(fn api-key-shaped? [name]
  (let [s (tostring (or name ""))]
    (and (string.match s "^[A-Z][A-Z0-9_]*$")
         (or (string.match s "_KEY$")
             (string.match s "_TOKEN$")
             (string.match s "_SECRET$")
             (string.match s "^KEY$")))))

;; @doc fen_web.shims.fs-kv.getenv
;; kind: function
;; signature: (getenv kv name) -> string|nil
;; summary: kv-backed os.getenv replacement, allowlisted to API-key-shaped names only (see api-key-shaped?) and namespaced under "env/apikey/" so it can't collide with settings.json/models.json paths or be widened by accident. Everything not API-key-shaped returns nil without ever consulting kv. This is where issue #7's BYO-key storage writes provider API keys (models.fnl's apiKey env-var-name convention resolves through this).
;; tags: shims kv env auth
(fn M.getenv [kv name]
  (if (api-key-shaped? name)
      (kv.get (.. "env/apikey/" (tostring name)))
      nil))

;; @doc fen_web.shims.fs-kv.install!
;; kind: function
;; signature: (install! kv) -> nil
;; summary: Monkey-patch the global io.open/os.remove/os.rename/os.execute/os.getenv to the kv-backed implementations above, so fen.core.settings and fen.core.llm.models load and run unmodified against host.kv. Call once from runtime bootstrap before those modules are required (see the module-doc install-order note for why that ordering constraint is Busted-only). Asserts kv has get/put/delete function fields so a misconfigured caller fails at install time, not on the first misbehaving read.
;; tags: shims kv fs io bootstrap
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
  (set os.getenv (fn [name] (M.getenv kv name)))
  nil)

;; @doc fen_web.shims.fs-kv.snapshot-globals
;; kind: function
;; signature: (snapshot-globals) -> table
;; summary: Capture the current io.open/os.remove/os.rename/os.execute/os.getenv globals, for uninstall! to restore later. Call before install! (or before any prior install! on this VM) to save the real/previous implementations.
;; tags: shims kv fs io bootstrap test
(fn M.snapshot-globals []
  {:io-open io.open
   :os-remove os.remove
   :os-rename os.rename
   :os-execute os.execute
   :os-getenv os.getenv})

;; @doc fen_web.shims.fs-kv.uninstall!
;; kind: function
;; signature: (uninstall! snapshot) -> nil
;; summary: Restore the globals captured by snapshot-globals, undoing install!. Production runtime boot has no reason to call this (the shim is installed once, for the life of the VM); it exists for tests that install! per-case and must not leak the patch into unrelated specs.
;; tags: shims kv fs io bootstrap test
(fn M.uninstall! [snapshot]
  (set io.open snapshot.io-open)
  (set os.remove snapshot.os-remove)
  (set os.rename snapshot.os-rename)
  (set os.execute snapshot.os-execute)
  (set os.getenv snapshot.os-getenv)
  nil)

M
