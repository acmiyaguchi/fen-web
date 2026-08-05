;; Browser-native `ls` tool: same name/schema/result shape as fen's
;; builtin ls.fnl, backed by fen_web.tools.vfs.list-dir (a single
;; kv.list prefix scan) instead of shelling out to POSIX `ls`.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local truncate (require :fen_web.tools.truncate))

(fn run-ls [{: path : limit} _ctx ?yield-fn]
  (let [target (or path ".")
        kv (util.get-kv)
        take (math.max 1 (util.int-arg limit truncate.DEFAULT-MAX-LINES))
        explicit-limit? (not= (util.int-arg limit nil) nil)
        (listing lerr) (vfs.list-dir kv target ?yield-fn)]
    (if lerr
        (if (string.find lerr ": Not a directory" 1 true)
            ;; target names a file, not a directory: POSIX `ls` on a
            ;; file just prints that file's name, it doesn't error.
            (let [(norm _) (vfs.normalize target)]
              (util.ok (util.basename norm)))
            (util.err lerr))
        (let [entries []]
          ;; fen's ls shells out to `ls -1`, which prints bare names with
          ;; no trailing "/" on directories; match that exactly since
          ;; this output feeds back into prompts.
          (each [_ d (ipairs listing.dirs)] (table.insert entries d))
          (each [_ f (ipairs listing.files)] (table.insert entries f))
          (table.sort entries)
          (let [total (length entries)
                out []]
            (for [i 1 (math.min total take)]
              (table.insert out (. entries i)))
            (when (and (> total take) (not explicit-limit?))
              (table.insert out (.. "[truncated: output capped at "
                                    (tostring take) " lines]")))
            (util.ok (table.concat out "\n")))))))

{:name :ls
 :label "Ls"
 :snippet "List directory contents"
 :description "List entries in a directory."
 :parameters {:type :object
              :properties {:path {:type :string :description "Directory (defaults to .)"}
                           :limit {:type :integer
                                   :description "Maximum number of entries to return"}}}
 :execute run-ls}
