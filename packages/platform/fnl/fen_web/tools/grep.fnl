;; Browser-native `grep` tool: same name/schema/result shape as fen's
;; builtin grep.fnl, which shells out to POSIX `grep`. Neither io.popen
;; nor a PCRE library exist here, so this walks fen_web.tools.vfs and
;; matches each line with either a plain substring search (`literal`) or
;; a Lua pattern (default) via string.find -- Lua patterns are NOT full
;; regex (no alternation `|`, no `{m,n}` bounds); this is a deliberate,
;; documented divergence from fen's grep(1)-backed regex support.
;; `ignore_case` lowercases both the line and the pattern before matching
;; in either mode; for Lua-pattern mode this can misbehave with explicit
;; character classes like `%u`, which is an accepted rough edge of that
;; divergence.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local globmod (require :fen_web.tools.glob))
(local truncate (require :fen_web.tools.truncate))
(local path-ops (require :fen_web.tools.path_ops))

(fn filter-by-glob [all pattern ?yield-fn]
  (let [out []]
    (var scanned 0)
    (each [_ p (ipairs all)]
      (when (globmod.matches? pattern (util.basename p)) (table.insert out p))
      (set scanned (+ scanned 1))
      (when (and ?yield-fn (= (% scanned 512) 0)) (?yield-fn)))
    out))

(fn line-matches? [line pattern ignore-case? literal?]
  (let [l (if ignore-case? (line:lower) line)
        p (if ignore-case? (pattern:lower) pattern)]
    (if literal?
        (not= (string.find l p 1 true) nil)
        (let [(ok? res) (pcall string.find l p)]
          (and ok? (not= res nil))))))

(fn matched-lines [lines pattern ignore-case? literal? ?yield-fn]
  (let [out []]
    (var scanned 0)
    (each [i line (ipairs lines)]
      (when (line-matches? line pattern ignore-case? literal?)
        (table.insert out i))
      (set scanned (+ scanned 1))
      (when (and ?yield-fn (= (% scanned 512) 0)) (?yield-fn)))
    out))

(fn compute-flags [n matched-list context-n]
  (let [flags {}]
    (each [_ idx (ipairs matched-list)]
      (for [d (- context-n) context-n]
        (let [j (+ idx d)]
          (when (and (>= j 1) (<= j n) (not (. flags j)))
            (tset flags j :context)))))
    (each [_ idx (ipairs matched-list)] (tset flags idx :match))
    flags))

(fn emit-file [path lines matched-list context-n out cap ?yield-fn]
  "Append formatted lines to out (mutated), stopping once cap is hit.
   Returns true when cap was hit (caller should stop scanning further
   files)."
  (let [n (length lines)
        flags (compute-flags n matched-list context-n)]
    (var prev nil)
    (var stopped? false)
    (for [i 1 n &until stopped?]
      (let [kind (. flags i)]
        (when kind
          (if (>= (length out) cap)
              (set stopped? true)
              (do
                (when (and prev (> (- i prev) 1))
                  (if (>= (length out) cap)
                      (set stopped? true)
                      (table.insert out "--")))
                (when (not stopped?)
                  (let [sep (if (= kind :match) ":" "-")]
                    (table.insert out (.. path sep (tostring i) sep (. lines i)))
                    (set prev i))))))))
    (util.maybe-yield ?yield-fn)
    stopped?))

(fn run-grep [{: pattern : path : glob : ignore_case : literal : context : limit} ctx ?yield-fn]
  (if (or (not pattern) (= pattern ""))
      (util.err "missing 'pattern'")
      (let [kv (util.get-kv)
            raw-target (or path ".")
            (target perr) (path-ops.resolve-path raw-target ctx)
            cap (util.int-arg limit 200)
            context-n (or (util.int-arg context nil) 0)]
        (if perr
            (util.err perr)
            (let [(single-content _read-err) (vfs.read-file kv target)]
        (if single-content
            (let [(norm _) (vfs.normalize target)
                  lines (util.split-lines single-content)
                  matches (matched-lines lines pattern ignore_case literal ?yield-fn)
                  out []]
              (emit-file norm lines matches context-n out cap ?yield-fn)
              (let [(capped _) (truncate.truncate-head (table.concat out "\n") nil ?yield-fn)]
                (util.ok capped)))
            (let [(all werr) (vfs.walk kv target ?yield-fn)]
              (if werr
                  (util.err werr)
                  (let [files (if (and glob (not= glob ""))
                                  (filter-by-glob all glob ?yield-fn)
                                  all)
                        out []]
                    (var stopped? false)
                    (each [_ p (ipairs files) &until stopped?]
                      (let [(content rerr) (vfs.read-file kv p)]
                        (when (not rerr)
                          (let [lines (util.split-lines content)
                                matches (matched-lines lines pattern ignore_case literal ?yield-fn)]
                            (when (> (length matches) 0)
                              (set stopped? (emit-file p lines matches context-n out cap ?yield-fn)))))))
                    (let [(capped _) (truncate.truncate-head (table.concat out "\n") nil ?yield-fn)]
                      (util.ok capped)))))))))))

{:name :grep
 :label "Grep"
 :snippet "Search file contents with regex"
 :description "Search files for a pattern. Recursive when path is a directory. Patterns are Lua string patterns (not full regex: no alternation or {m,n} bounds), unless literal is set."
 :parameters {:type :object
              :properties {:pattern {:type :string :description "Pattern to search for"}
                           :path {:type :string :description "File or directory (default: .)"}
                           :glob {:type :string
                                  :description "Filename glob filter, e.g. *.fnl"}
                           :ignore_case {:type :boolean
                                         :description "Case-insensitive match"}
                           :literal {:type :boolean
                                     :description "Treat pattern as literal text, not a Lua pattern"}
                           :context {:type :integer
                                     :description "Lines of context before/after each match"}
                           :limit {:type :integer
                                   :description "Maximum output lines (default 200)"}}
              :required [:pattern]}
 :execute run-grep}
