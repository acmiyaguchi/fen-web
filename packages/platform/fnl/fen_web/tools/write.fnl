;; Browser-native `write` tool: same name/schema/result shape as fen's
;; builtin write.fnl, writing through fen_web.tools.vfs (host.kv) instead
;; of io.open. "Creates the parent directory if missing" is true by
;; construction here -- vfs directories are implicit key prefixes, so
;; there is nothing to mkdir.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local path-ops (require :fen_web.tools.path_ops))

(fn run-write [{: path : content} ctx ?yield-fn]
  (if (or (not path) (= path ""))
      (util.err "missing 'path'")
      (let [(resolved perr) (path-ops.resolve-path path ctx)]
        (if perr
            (util.err perr)
            (let [(ok? werr) (vfs.write-file (util.get-kv) resolved content)]
              (util.maybe-yield ?yield-fn)
              (if (not ok?)
                  (util.err werr)
                  (util.ok (.. "wrote " (tostring (length (or content "")))
                               " bytes to " resolved))))))))

{:name :write
 :label "Write"
 :snippet "Create or overwrite a file"
 :description "Write content to a file (overwrites). Creates the parent directory if missing."
 :parameters {:type :object
              :properties {:path {:type :string :description "File path"}
                           :content {:type :string :description "Content to write"}}
              :required [:path :content]}
 :execute run-write}
