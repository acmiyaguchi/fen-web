;; Minimal filename-glob matching (`*`, `?`, literal chars) implemented
;; over Lua patterns, since neither fnmatch(3) nor io.popen (fen's find
;; shells out to POSIX `find -name`) exist in this pure-Fennel/browser
;; environment. `*` and `?` are the only wildcards; everything else,
;; including other glob syntax like `[abc]` or `{a,b}`, is matched
;; literally. This is a deliberate divergence from POSIX glob(7), scoped
;; to what fen's own `pattern` docs ("e.g. *.fnl") actually promise.

(local MAGIC "^$()%.[]+-")

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

{: to-pattern
 : matches?}
