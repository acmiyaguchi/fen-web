;; Browser-native `read` tool: same name/schema/result shape as fen's
;; extensions/behaviors/kernel/builtin-tools/read.fnl, but reading from
;; the virtual FS (fen_web.tools.vfs, over host.kv) instead of io.open.
;; Divergence: fen's full-slurp truncation tag references a spilled
;; `full output: <path>`; there's no local fs to spill into here, see
;; fen_web.tools.truncate.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local truncate (require :fen_web.tools.truncate))

(local LINES-BEFORE-YIELD 512)

(fn read-lines-slice [lines start take ?yield-fn]
  (let [out []]
    (var n 0)
    (var scanned 0)
    (each [_ line (ipairs lines)]
      (set n (+ n 1))
      (set scanned (+ scanned 1))
      (when (and (>= n start) (< (length out) take))
        (table.insert out line))
      (when (and ?yield-fn (>= scanned LINES-BEFORE-YIELD))
        (set scanned 0)
        (?yield-fn)))
    (table.concat out "\n")))

(fn run-read-one [{: path : offset : limit} ?yield-fn]
  (if (or (not path) (= path ""))
      (util.err "missing 'path'")
      (let [(content rerr) (vfs.read-file (util.get-kv) path)]
        (if rerr
            (util.err rerr)
            (if (and (not offset) (not limit))
                (let [(capped _) (truncate.truncate-head content nil ?yield-fn)]
                  (util.ok capped))
                (let [start (util.int-arg offset 1)
                      take (or (util.int-arg limit nil) math.huge)
                      lines (util.split-lines content)]
                  (util.ok (read-lines-slice lines start take ?yield-fn))))))))

(fn normalize-read-spec [spec]
  (if (= (type spec) :string) {:path spec} spec))

(fn run-read-batch [paths ?yield-fn]
  (if (or (not paths) (= (length paths) 0))
      (util.err "missing 'paths'")
      (let [parts []]
        (each [_ raw (ipairs paths)]
          (let [spec (normalize-read-spec raw)
                path (?. spec :path)
                header (.. "==> " (or path "<missing path>") " <==")
                r (run-read-one (or spec {}) ?yield-fn)]
            (table.insert parts (.. header "\n" (util.result-text r)))
            (util.maybe-yield ?yield-fn)))
        (util.ok (table.concat parts "\n\n")))))

(fn run-read [args _ctx ?yield-fn]
  (let [has-path? (and args.path (not= args.path ""))
        has-paths? (not= args.paths nil)]
    (if (and has-path? has-paths?)
        (util.err "provide either 'path' or 'paths', not both")
        has-paths?
        (run-read-batch args.paths ?yield-fn)
        (run-read-one args ?yield-fn))))

{:name :read
 :label "Read"
 :snippet "Read a file's contents"
 :description "Read one or more files. Prefer the batch shape `{paths:[...]}` whenever multiple independent files are needed; do not emit separate read calls for files you already know you need. Single-file shape: {path, optional offset/limit}. Batch shape: {paths:[path-or-{path,offset,limit}, ...]}, e.g. {paths:[\"src/a.fnl\", {path:\"src/b.fnl\", offset:10, limit:40}]}. Default full slurp is head-truncated per file to ~50KB / 2000 lines; when truncated, page through the original explicitly with offset/limit. In batched reads, missing/unreadable files are reported inline under that path's header; the overall call still succeeds."
 :parameters {:type :object
              :properties {:path {:type :string
                                  :description "File path for single-file reads; mutually exclusive with paths"}
                           :paths {:type :array
                                   :description "Preferred for multiple independent reads. Batch several files in one call. Items may be path strings or {path, offset, limit} objects; mutually exclusive with path."
                                   :items {:anyOf [{:type :string}
                                                   {:type :object
                                                    :properties {:path {:type :string}
                                                                 :offset {:type :integer}
                                                                 :limit {:type :integer}}
                                                    :required [:path]}]}}
                           :offset {:type :integer
                                    :description "1-indexed start line for single-file reads"}
                           :limit {:type :integer
                                   :description "Maximum number of lines to return"}}}
 :execute run-read}
