;; Shared safety checks for mutating virtual-filesystem tools.
;;
;; The browser workspace has one virtual root (`/`). Callers may provide a
;; narrower `ctx.workspace-root`; paths are normalized before the containment
;; check, so `..` cannot bypass it. Directories are implicit key prefixes and
;; are intentionally not accepted by delete/move: callers must remove files
;; one at a time rather than triggering an unbounded recursive operation.

(local vfs (require :fen_web.tools.vfs))

(fn resolve-path [path ctx]
  "Resolve relative paths against the tool context cwd, then normalize."
  (let [p (or path "")
        raw-cwd (or (?. ctx :cwd) "/")
        cwd (if (= raw-cwd "") "/" raw-cwd)
        absolute? (= (string.sub p 1 1) "/")
        candidate (if absolute?
                     p
                     (.. cwd "/" p))]
    (vfs.normalize candidate)))

(fn normalize-in-workspace [path ctx]
  (let [(norm nerr) (resolve-path path ctx)]
    (if nerr
        (values nil nerr)
        (let [(root rerr) (vfs.normalize (or (?. ctx :workspace-root) "/"))]
          (if rerr
              (values nil (.. "invalid workspace root: " rerr))
              (if (or (= root "/")
                      (= norm root)
                      (= (string.sub norm 1 (+ (length root) 1)) (.. root "/")))
                  (values norm nil)
                  (values nil (.. "path is outside workspace root " root))))))))

(fn file-kind [kv norm]
  (let [(content rerr) (vfs.read-file kv norm)]
    (if (not rerr)
        (values :file nil)
        (= norm "/")
        (values :directory "directories are not supported")
        (not= (string.find rerr "Is a directory" 1 true) nil)
        (values :directory "directories are not supported")
        (values nil rerr))))

{: resolve-path
 : normalize-in-workspace
 : file-kind}
