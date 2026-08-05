;; Shared test support for packages/platform specs: a synchronous
;; table-backed kv (the Busted-side stand-in docs/bindings/kv.md and the
;; issue #15 brief describe) plus save/restore helpers for the globals
;; fen_web.shims.fs-kv monkey-patches, so one spec's `install!` can't leak
;; into another spec file.

(local M {})

;; @doc test-support.make-kv
;; kind: function
;; signature: (make-kv) -> HostKv
;; summary: A synchronous, table-backed stand-in for host.kv: get/put/delete/list over a plain Lua table, ascending-lexicographic list(prefix) like the real IndexedDB-backed kv.
;; tags: test support kv
(fn M.make-kv []
  (let [store {}]
    {:get (fn [key] (. store key))
     :put (fn [key value] (tset store key value) nil)
     :delete (fn [key] (tset store key nil) nil)
     :list (fn [prefix]
             (let [prefix (or prefix "")
                   keys []]
               (each [k _ (pairs store)]
                 (when (= (string.sub k 1 (length prefix)) prefix)
                   (table.insert keys k)))
               (table.sort keys)
               keys))
     :__store store}))

;; @doc test-support.snapshot-globals
;; kind: function
;; signature: (snapshot-globals) -> table
;; summary: Capture the io.open/os.remove/os.rename/os.execute/os.getenv globals fs-kv.install! patches, for restore-globals to undo after a spec.
;; tags: test support globals
(fn M.snapshot-globals []
  {:io-open io.open
   :os-remove os.remove
   :os-rename os.rename
   :os-execute os.execute
   :os-getenv os.getenv})

;; @doc test-support.restore-globals
;; kind: function
;; signature: (restore-globals snap) -> nil
;; summary: Restore globals captured by snapshot-globals, undoing fs-kv.install! so later spec files see the real io/os.
;; tags: test support globals
(fn M.restore-globals [snap]
  (set io.open snap.io-open)
  (set os.remove snap.os-remove)
  (set os.rename snap.os-rename)
  (set os.execute snap.os-execute)
  (set os.getenv snap.os-getenv)
  nil)

M
