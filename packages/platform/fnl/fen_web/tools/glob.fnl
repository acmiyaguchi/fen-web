;; Minimal filename-glob matching (`*`, `?`, literal chars) implemented
;; over Lua patterns, since neither fnmatch(3) nor io.popen (fen's find
;; shells out to POSIX `find -name`) exist in this pure-Fennel/browser
;; environment. `*` and `?` are the only wildcards; everything else,
;; including other glob syntax like `[abc]` or `{a,b}`, is matched
;; literally. This is a deliberate divergence from POSIX glob(7), scoped
;; to what fen's own `pattern` docs ("e.g. *.fnl") actually promise.

(local MAGIC "^$()%.[]+-")
(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local truncate (require :fen_web.tools.truncate))
(local path-ops (require :fen_web.tools.path_ops))

(fn escape-char [c]
  (if (string.find MAGIC c 1 true) (.. "%" c) c))

;; @doc fen_web.tools.glob.to-pattern
;; kind: function
;; signature: (to-pattern glob) -> lua-pattern-string
;; summary: Convert a `*`/`?` filename glob into an anchored Lua string.find pattern.
;; tags: tools glob pattern
(fn to-pattern [glob]
  (var out "^")
  (for [i 1 (length glob)]
    (let [c (string.sub glob i i)]
      (set out (.. out
                   (if (= c "*") ".*"
                       (= c "?") "."
                       (escape-char c))))))
  (.. out "$"))

;; @doc fen_web.tools.glob.matches?
;; kind: function
;; signature: (matches? glob name) -> boolean
;; summary: True when name matches a `*`/`?` filename glob in full.
;; tags: tools glob match
(fn matches? [glob name]
  (not= (string.find name (to-pattern glob)) nil))

;; @doc fen_web.tools.glob.execute
;; kind: function
;; signature: (execute args ctx? yield-fn?) -> AgentToolResult
;; summary: List virtual-filesystem files recursively by basename glob.
;; tags: tools glob execute
(fn run-glob [{: pattern : path : limit} ctx ?yield-fn]
  (if (or (not pattern) (= pattern ""))
      (util.err "missing 'pattern'")
      (let [raw-target (or path ".")
            (target perr) (path-ops.resolve-path raw-target ctx)
            cap (math.max 1 (util.int-arg limit 200))]
        (if perr
            (util.err perr)
            (let [(all werr) (vfs.walk (util.get-kv) target ?yield-fn)]
          (if werr
            (util.err werr)
            (let [out []]
              (var scanned 0)
              (var capped? false)
              (each [_ p (ipairs all) &until capped?]
                (when (matches? pattern (util.basename p))
                  (if (< (length out) cap)
                      (table.insert out p)
                      (set capped? true)))
                (set scanned (+ scanned 1))
                (when (and ?yield-fn (= (% scanned 512) 0)) (?yield-fn)))
              (let [(capped _) (truncate.truncate-head (table.concat out "\n") nil ?yield-fn)]
                (util.ok capped)))))))))

{: to-pattern
 : matches?
 :name :glob
 :label "Glob"
 :snippet "Find files by a filename glob"
 :description "List files recursively matching a filename glob such as *.fnl. Only * and ? are wildcards; matching is against basenames."
 :parameters {:type :object
              :properties {:pattern {:type :string
                                     :description "Filename glob, e.g. *.fnl"}
                           :path {:type :string
                                  :description "Directory to search (default: .)"}
                           :limit {:type :integer
                                   :description "Maximum results (default 200)"}}
              :required [:pattern]}
 :execute run-glob}
