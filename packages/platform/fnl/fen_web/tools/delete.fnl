;; Browser-native `delete` tool over the virtual filesystem.
;;
;; Only individual files are supported. Directories are implicit prefixes in
;; host.kv, so recursive deletion is deliberately refused; this avoids an
;; accidental broad delete and makes the operation's safety boundary clear.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local path-ops (require :fen_web.tools.path_ops))

(fn delete-file [norm ?yield-fn]
  (let [kv (util.get-kv)
        (kind ferr) (path-ops.file-kind kv norm)]
    (if (not kind)
        (util.err (.. "cannot delete " norm ": " ferr))
        (= kind :directory)
        (util.err (.. norm ": " ferr))
        (let [(ok? derr) (vfs.delete kv norm)]
          (util.maybe-yield ?yield-fn)
          (if derr
              (util.err derr)
              (util.ok (.. "deleted " norm)))))))

(fn run-delete [{: path} ctx ?yield-fn]
  (if (or (not path) (= path ""))
      (util.err "missing 'path'")
      (let [(norm perr) (path-ops.normalize-in-workspace path ctx)]
        (if perr
            (util.err perr)
            (let [(ok? result) (pcall delete-file norm ?yield-fn)]
              (if ok?
                  result
                  (util.err (tostring result))))))))

{:name :delete
 :label "Delete"
 :snippet "Delete a file"
 :description "Delete one file from the virtual filesystem rooted at /. Directories are not supported; an optional host-provided context boundary may reject a path, and missing files return an error."
 :parameters {:type :object
              :properties {:path {:type :string :description "File path to delete"}}
              :required [:path]}
 :execute run-delete}
