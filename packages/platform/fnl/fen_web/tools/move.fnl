;; Browser-native `move`/rename tool over the virtual filesystem.
;;
;; host.kv has no rename primitive, so this is intentionally the portable
;; read -> write -> delete sequence. It only moves individual files; implicit
;; directories are refused. Existing destinations are refused unless the
;; caller explicitly passes overwrite=true, and the source is deleted only
;; after the destination write succeeds.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local path-ops (require :fen_web.tools.path_ops))

(fn move-file [from to overwrite? ?yield-fn]
  (let [kv (util.get-kv)
        (kind ferr) (path-ops.file-kind kv from)]
    (if (not kind)
        (util.err (.. "cannot move " from ": " ferr))
        (= kind :directory)
        (util.err (.. from ": " ferr))
        (= from to)
        (util.ok (.. "moved " from " to " to))
        (let [destination-exists? (vfs.exists? kv to)]
          (if (and destination-exists? (not overwrite?))
              (util.err (.. "destination " to " already exists; pass overwrite:true to replace it"))
              (let [(content rerr) (vfs.read-file kv from)]
                (if rerr
                    (util.err rerr)
                    (let [(ok? werr) (vfs.write-file kv to content)]
                      (if (not ok?)
                          (util.err (.. "cannot move to " to ": " werr))
                          (let [(deleted? derr) (vfs.delete kv from)]
                            (util.maybe-yield ?yield-fn)
                            (if derr
                                (util.err (.. "moved destination but could not delete source: " derr))
                                (util.ok (.. "moved " from " to " to
                                             (if destination-exists?
                                                 " (overwrote existing destination)"
                                                 ""))))))))))))))

(fn run-move [{: source : destination : overwrite} ctx ?yield-fn]
  (if (or (not source) (= source ""))
      (util.err "missing 'source'")
      (or (not destination) (= destination ""))
      (util.err "missing 'destination'")
      (let [(from from-err) (path-ops.normalize-in-workspace source ctx)
            (to to-err) (path-ops.normalize-in-workspace destination ctx)]
        (if from-err
            (util.err from-err)
            to-err
            (util.err to-err)
            (let [(ok? result) (pcall move-file from to overwrite ?yield-fn)]
              (if ok?
                  result
                  (util.err (tostring result))))))))

{:name :move
 :label "Move"
 :snippet "Move or rename a file"
 :description "Move or rename one file in the virtual filesystem rooted at /. Uses read/write/delete, refuses directories, honors an optional host-provided context boundary, and refuses an existing destination unless overwrite=true."
 :parameters {:type :object
              :properties {:source {:type :string :description "Existing file path"}
                           :destination {:type :string :description "Destination file path"}
                           :overwrite {:type :boolean
                                       :description "Replace an existing destination (default false)"}}
              :required [:source :destination]}
 :execute run-move}
