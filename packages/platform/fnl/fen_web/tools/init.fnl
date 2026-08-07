;; Browser file-tool extension (fen-web#4 / fen#99 design findings).
;;
;; fen has no filesystem seam to fill: its builtin read/edit/write/find/
;; grep/ls tools call io.open/io.popen/os.execute directly
;; (fen/extensions/behaviors/kernel/builtin-tools/). This extension does
;; NOT load that builtin-tools extension in the browser. Instead it
;; registers browser-native tools under the SAME names via the ordinary
;; public `:tool` register kind (fen.core.extensions.register.tool),
;; exactly like builtin-tools registers itself
;; (fen/extensions/behaviors/kernel/builtin-tools/init.fnl) -- no fen
;; core change needed. Virtual-FS path/tree semantics live beneath these
;; tools in fen_web.tools.vfs, layered over host.kv.
;;
;; Deliberate divergence from fen's builtin tool set: no `bash` tool is
;; registered here. fen's bash builtin shells out via os.execute/
;; io.popen, which has no browser equivalent and no vfs-backed
;; replacement is in scope for this issue.

;; pick-values guards the tail entry: require returns a second value
;; (the loader data) under two-value searchers like the runtime's
;; source-map searcher, which would otherwise splice into the list.
(local tool-specs
  [(require :fen_web.tools.read)
   (require :fen_web.tools.write)
   (require :fen_web.tools.edit)
   (require :fen_web.tools.grep)
   (require :fen_web.tools.find)
   (require :fen_web.tools.ls)
   (require :fen_web.tools.delete)
   (require :fen_web.tools.move)
   (pick-values 1 (require :fen_web.tools.tool_search))])

(local web-fetch-tool (pick-values 1 (require :fen_web.tools.web_fetch)))

(local M {})

;; @doc fen_web.tools.register
;; kind: function
;; signature: (register api) -> true
;; summary: Register the browser-native workspace tools plus registry-generic tool_search, with web_fetch opt-in through the web boot options.
;; tags: fen-web tools register extension
(fn M.register [api ?opts]
  (each [_ spec (ipairs tool-specs)]
    ;; Keep the core workspace surface and tool_search immediately available;
    ;; specialized browser capabilities use :search exposure below.
    (set spec.exposure :always)
    (api.register :tool spec))
  (when (and ?opts (?. ?opts :enable-web-fetch))
    (set web-fetch-tool.exposure :search)
    (api.register :tool web-fetch-tool))
  true)

M
