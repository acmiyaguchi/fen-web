;; Shared helpers for fen-web's browser-native file tools. Deliberately
;; independent of fen.core.types -- this extension lives outside fen's
;; own package tree, so it inlines the small AgentToolResult shape
;; ({:content [{:type :text :text ...}] :is-error? bool}) rather than
;; requiring fen.core.

;; @doc fen_web.tools.util.ok
;; kind: function
;; signature: (ok text) -> AgentToolResult
;; summary: Wrap successful plain text output as a canonical non-error AgentToolResult.
;; tags: tools results util
(fn ok [text]
  {:content [{:type :text :text (or text "")}] :is-error? false})

;; @doc fen_web.tools.util.err
;; kind: function
;; signature: (err message) -> AgentToolResult
;; summary: Wrap an error message as an AgentToolResult whose text is prefixed with error:, matching fen's builtin tools.
;; tags: tools results util
(fn err [message]
  {:content [{:type :text :text (.. "error: " message)}] :is-error? true})

;; @doc fen_web.tools.util.int-arg
;; kind: function
;; signature: (int-arg v default) -> number
;; summary: Normalize numeric tool arguments by converting to an integer or returning the provided default.
;; tags: tools args util
(fn int-arg [v default]
  (let [n (tonumber v)]
    (if n (math.floor n) default)))

;; @doc fen_web.tools.util.result-text
;; kind: function
;; signature: (result-text r) -> string
;; summary: Extract the first text block from an AgentToolResult, for tests and composed tool helpers.
;; tags: tools results util
(fn result-text [r]
  (let [b (and r.content (. r.content 1))]
    (if (and b (= b.type :text)) b.text "")))

;; @doc fen_web.tools.util.maybe-yield
;; kind: function
;; signature: (maybe-yield ?yield-fn) -> nil
;; summary: Call yield-fn when present; a no-op helper so long loops read uniformly whether cooperative or not.
;; tags: tools yield util
(fn maybe-yield [?yield-fn]
  (when ?yield-fn (?yield-fn)))

;; @doc fen_web.tools.util.split-lines
;; kind: function
;; signature: (split-lines s) -> [string]
;; summary: Split s into a line array, matching Lua's f:lines() semantics (no trailing empty element for a final newline).
;; tags: tools text util
(fn split-lines [s]
  (let [s2 (if (and (> (length s) 0) (= (string.sub s -1) "\n"))
               (string.sub s 1 -2)
               s)]
    (if (= s2 "")
        []
        (icollect [line (string.gmatch (.. s2 "\n") "([^\n]*)\n")] line))))

;; @doc fen_web.tools.util.basename
;; kind: function
;; signature: (basename path) -> string
;; summary: Final path segment (POSIX basename), used by ls/find/grep for filename-glob matching and single-file ls output.
;; tags: tools path util
(fn basename [path]
  (or (string.match path "([^/]+)$") path))

;; @doc fen_web.tools.util.get-kv
;; kind: function
;; signature: (get-kv) -> HostKv
;; summary: Resolve host.kv from the global host bridge at call time (mirrors fen.util.http.backends.fetch's _G.__fen_host lookup), erroring clearly when absent.
;; tags: tools host seam kv
(fn get-kv []
  (let [host _G.__fen_host]
    (if (and host host.kv)
        host.kv
        (error "fen_web.tools: __fen_host.kv is not installed"))))

{: ok
 : err
 : int-arg
 : result-text
 : maybe-yield
 : split-lines
 : basename
 : get-kv}
