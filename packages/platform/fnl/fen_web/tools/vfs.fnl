;; Virtual filesystem over host.kv (fen#4 / fen-web#4).
;;
;; host.kv (see docs/bindings/kv.md) is a flat, synchronous-from-Fennel's
;; perspective string kv: get/put/delete/list(prefix). This module layers
;; path semantics on top: every stored file lives under a key
;; "fs:" .. <normalized-absolute-path>. There are no directory entries --
;; directories are implicit, discovered by listing key prefixes. That
;; means write-file "creates parent directories" for free (there is
;; nothing to create), and an empty directory cannot exist: a directory
;; exists exactly when some file's path starts with it.
;;
;; Every function here takes an explicit `kv` table as its first argument
;; (get/put/delete/list) rather than reaching for a global -- this module
;; doesn't care whether kv came from `_G.__fen_host.kv` (browser) or a
;; table-backed test double; that resolution is the tools' job (see
;; init.fnl), keeping this module trivially Busted-testable.
;;
;; Path normalization: paths are treated as absolute from a single root
;; "/". A leading slash is optional on input (relative paths are treated
;; as rooted at "/"). "." segments are dropped, ".." pops the previous
;; segment, and ".." with nothing to pop is a hard error (escaping above
;; root), never silently clamped -- callers (tools) turn that into an
;; error result rather than a filesystem hit.

(local KEY-PREFIX "fs:")

;; @doc fen_web.tools.vfs.normalize
;; kind: function
;; signature: (normalize path) -> normalized-path, nil | nil, error
;; summary: Normalize a path to an absolute, dot-free form, erroring if it would escape the virtual root.
;; tags: vfs path normalize
(fn normalize [path]
  (let [p (or path "")
        abs (if (= (string.sub p 1 1) "/") p (.. "/" p))
        segments []]
    (var err nil)
    (each [seg (string.gmatch abs "[^/]+")]
      (when (not err)
        (if (= seg ".") nil
            (= seg "..")
            (if (> (length segments) 0)
                (table.remove segments)
                (set err (.. "path escapes root: " path)))
            (table.insert segments seg))))
    (if err
        (values nil err)
        (values (if (= (length segments) 0)
                    "/"
                    (.. "/" (table.concat segments "/")))
                nil))))

(fn key-for [normalized-path]
  "normalized-path must already be normalize()'d."
  (.. KEY-PREFIX normalized-path))

(fn dir-prefix-for [normalized-path]
  "Key prefix under which every descendant of normalized-path lives."
  (if (= normalized-path "/")
      (.. KEY-PREFIX "/")
      (.. KEY-PREFIX normalized-path "/")))

(fn is-dir? [kv normalized-path]
  "True when normalized-path has at least one descendant key (an implicit
   directory), regardless of whether a file also happens to exist at
   that exact key (see the shadowing note on write-file below)."
  (> (length (kv.list (dir-prefix-for normalized-path))) 0))

(fn ancestor-conflict [kv normalized-path]
  "The first proper ancestor of normalized-path (nearest root first) that
   is itself a stored file, or nil. Used by write-file to refuse
   /a/b/c when /a is a file -- otherwise /a/b/c would silently create a
   key that /a's own file content can never be distinguished from
   again (the shadowing fen-web review flagged)."
  (let [segments []]
    (each [seg (string.gmatch normalized-path "[^/]+")]
      (table.insert segments seg))
    (var conflict nil)
    (var path "")
    (for [i 1 (- (length segments) 1)]
      (set path (.. path "/" (. segments i)))
      (when (and (not conflict) (not= (kv.get (key-for path)) nil))
        (set conflict path)))
    conflict))

;; @doc fen_web.tools.vfs.read-file
;; kind: function
;; signature: (read-file kv path) -> content, nil | nil, error
;; summary: Read a virtual file's full contents from host.kv; errors "Is a directory" for an implicit-dir path and "No such file or directory" otherwise, matching io.open-style messages.
;; tags: vfs read
(fn read-file [kv path]
  (let [(norm nerr) (normalize path)]
    (if nerr
        (values nil nerr)
        (let [v (kv.get (key-for norm))]
          (if (not= v nil)
              (values v nil)
              (if (is-dir? kv norm)
                  (values nil (.. norm ": Is a directory"))
                  (values nil (.. norm ": No such file or directory"))))))))

;; @doc fen_web.tools.vfs.write-file
;; kind: function
;; signature: (write-file kv path content) -> true, nil | nil, error
;; summary: Write (create or overwrite) a virtual file's contents; parent directories are implicit and need no creation. Refuses to write when the path is itself an implicit directory, or when a proper ancestor is already a file, so a file key and a directory prefix can never shadow each other.
;; tags: vfs write
(fn write-file [kv path content]
  (let [(norm nerr) (normalize path)]
    (if nerr
        (values nil nerr)
        (if (is-dir? kv norm)
            (values nil (.. norm ": Is a directory"))
            (let [anc (ancestor-conflict kv norm)]
              (if anc
                  (values nil (.. anc ": Not a directory"))
                  (do (kv.put (key-for norm) (or content ""))
                      (values true nil))))))))

;; @doc fen_web.tools.vfs.delete
;; kind: function
;; signature: (delete kv path) -> true, nil | nil, error
;; summary: Delete a single virtual file. Does not recurse into directories.
;; tags: vfs delete
(fn delete [kv path]
  (let [(norm nerr) (normalize path)]
    (if nerr
        (values nil nerr)
        (do (kv.delete (key-for norm))
            (values true nil)))))

;; @doc fen_web.tools.vfs.exists?
;; kind: function
;; signature: (exists? kv path) -> boolean
;; summary: True when path is either a stored file or a non-empty implicit directory prefix.
;; tags: vfs stat
(fn exists? [kv path]
  (let [(norm nerr) (normalize path)]
    (if nerr
        false
        (or (not= (kv.get (key-for norm)) nil)
            (is-dir? kv norm)))))

;; @doc fen_web.tools.vfs.list-dir
;; kind: function
;; signature: (list-dir kv path ?yield-fn) -> {:dirs [string] :files [string]}, nil | nil, error
;; summary: List the immediate children (one level) of a virtual directory, split into sorted dirs and files.
;; tags: vfs list directory
(fn list-dir [kv path ?yield-fn]
  (let [(norm nerr) (normalize path)]
    (if nerr
        (values nil nerr)
        (let [prefix (dir-prefix-for norm)
              keys (kv.list prefix)]
          (if (and (= (length keys) 0) (not= norm "/"))
              ;; No descendants: either norm is a plain file (ENOTDIR,
              ;; matching fen's ls shelling out to a real ls on a file)
              ;; or nothing exists at norm at all.
              (if (not= (kv.get (key-for norm)) nil)
                  (values nil (.. norm ": Not a directory"))
                  (values nil (.. norm ": No such file or directory")))
              (let [dir-set {}
                    files []]
                (var n 0)
                (each [_ k (ipairs keys)]
                  (set n (+ n 1))
                  (let [rel (string.sub k (+ (length prefix) 1))
                        slash (string.find rel "/")]
                    (if slash
                        (tset dir-set (string.sub rel 1 (- slash 1)) true)
                        (table.insert files rel)))
                  (when (and ?yield-fn (= (% n 256) 0)) (?yield-fn)))
                (let [dirs []
                      deduped-files (icollect [_ f (ipairs files)]
                                      (if (not (. dir-set f)) f))]
                  (each [d _ (pairs dir-set)] (table.insert dirs d))
                  (table.sort dirs)
                  (table.sort deduped-files)
                  (values {:dirs dirs :files deduped-files} nil))))))))

;; @doc fen_web.tools.vfs.walk
;; kind: function
;; signature: (walk kv path ?yield-fn) -> [string], nil | nil, error
;; summary: Recursively list every file path (normalized, absolute) under a virtual directory, in ascending order.
;; tags: vfs walk recursive
(fn walk [kv path ?yield-fn]
  (let [(norm nerr) (normalize path)]
    (if nerr
        (values nil nerr)
        (let [prefix (dir-prefix-for norm)
              keys (kv.list prefix)]
          (if (and (= (length keys) 0) (not= norm "/"))
              (if (not= (kv.get (key-for norm)) nil)
                  (values nil (.. norm ": Not a directory"))
                  (values nil (.. norm ": No such file or directory")))
              (let [out []]
                (var n 0)
                (each [_ k (ipairs keys)]
                  (set n (+ n 1))
                  (table.insert out (string.sub k (+ (length KEY-PREFIX) 1)))
                  (when (and ?yield-fn (= (% n 256) 0)) (?yield-fn)))
                (table.sort out)
                (values out nil)))))))

{: normalize
 : read-file
 : write-file
 : delete
 : exists?
 : list-dir
 : walk}
