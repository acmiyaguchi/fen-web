;; Browser-native `find` tool: same name/schema/result shape as fen's
;; builtin find.fnl, which shells out to POSIX `find -name`. io.popen
;; doesn't exist here, so this walks fen_web.tools.vfs directly and
;; matches basenames with fen_web.tools.glob (`*`/`?` only -- see that
;; module's docstring for the divergence from full glob(7)).

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local glob (require :fen_web.tools.glob))
(local truncate (require :fen_web.tools.truncate))
(local path-ops (require :fen_web.tools.path_ops))

(fn run-find [{: pattern : path : limit} ctx ?yield-fn]
  (if (or (not pattern) (= pattern ""))
      (util.err "missing 'pattern'")
      (let [raw-target (or path ".")
            (target perr) (path-ops.resolve-path raw-target ctx)
            cap (util.int-arg limit 200)]
        (if perr
            (util.err perr)
            (let [(all werr) (vfs.walk (util.get-kv) target ?yield-fn)]
          (if werr
            (util.err werr)
            (let [out []]
              (var truncated? false)
              (var scanned 0)
              (each [_ p (ipairs all) &until truncated?]
                (when (glob.matches? pattern (util.basename p))
                  (if (< (length out) cap)
                      (table.insert out p)
                      (set truncated? true)))
                (set scanned (+ scanned 1))
                (when (and ?yield-fn (= (% scanned 512) 0)) (?yield-fn)))
              (let [(capped _) (truncate.truncate-head (table.concat out "\n") nil ?yield-fn)]
                (util.ok capped)))))))))

{:name :find
 :label "Find"
 :snippet "Find files by name pattern"
 :description "Locate files by name glob, recursively."
 :parameters {:type :object
              :properties {:pattern {:type :string
                                     :description "Glob pattern, e.g. *.fnl"}
                           :path {:type :string
                                  :description "Directory (default: .)"}
                           :limit {:type :integer
                                   :description "Maximum results (default 200)"}}
              :required [:pattern]}
 :execute run-find}
