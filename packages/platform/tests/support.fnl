;; Shared test support for packages/platform specs: a synchronous
;; table-backed kv (the Busted-side stand-in docs/bindings/kv.md describes).
;; fs-kv still patches direct POSIX globals for Codex auth/diagnostics, so
;; snapshot helpers capture all globals that install! can change.

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

(fn api-key-shaped? [name]
  (let [s (tostring (or name ""))]
    (and (string.match s "^[A-Z][A-Z0-9_]*$")
         (or (string.match s "_KEY$")
             (string.match s "_TOKEN$")
             (string.match s "_SECRET$")
             (string.match s "^KEY$")))))

;; @doc test-support.install-kv-seams!
;; kind: function
;; signature: (install-kv-seams! kv) -> nil
;; summary: Preload the v0.17 storage/path backend seams with a synchronous kv double for tests of fen.core.settings and fen.core.llm.models.
;; tags: test support seams storage path
(fn M.install-kv-seams! [kv]
  (tset package.loaded :fen.core.storage.backend
        {:read (fn [path] (kv.get path))
         :write! (fn [path content] (kv.put path content))})
  (tset package.loaded :fen.util.path.backend
        {:getenv (fn [name]
                   (if (api-key-shaped? name)
                       (kv.get (.. "env/apikey/" (tostring name)))
                       nil))
         :stat (fn [_path] nil)
         :list-dir (fn [_dir] [])
         :pwd-physical (fn [_dir] ".")})
  (tset package.loaded :fen.core.storage nil)
  (tset package.loaded :fen.util.path nil)
  nil)

;; @doc test-support.clear-kv-seams!
;; kind: function
;; signature: (clear-kv-seams!) -> nil
;; summary: Clear public and preloaded v0.17 seam modules so the next spec can install a fresh backend double.
;; tags: test support seams storage path
(fn M.clear-kv-seams! []
  (tset package.loaded :fen.core.storage nil)
  (tset package.loaded :fen.core.storage.backend nil)
  (tset package.loaded :fen.util.path nil)
  (tset package.loaded :fen.util.path.backend nil)
  nil)

;; @doc test-support.snapshot-globals
;; kind: function
;; signature: (snapshot-globals) -> table
;; summary: Capture the io.open/os.remove/os.rename/os.execute/os.getenv globals retained by fs-kv.install!, for restore-globals to undo after a spec.
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
