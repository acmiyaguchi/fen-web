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

(local tool-specs
  [(require :fen_web.tools.read)
   (require :fen_web.tools.write)
   (require :fen_web.tools.edit)
   (require :fen_web.tools.grep)
   (require :fen_web.tools.find)
   (require :fen_web.tools.ls)])

(local M {})

;; @doc fen_web.tools.register
;; kind: function
;; signature: (register api) -> true
;; summary: Register the browser-native read/write/edit/grep/find/ls tool set under fen's builtin-tools names via api.register :tool.
;; tags: fen-web tools register extension
(fn M.register [api]
  (each [_ spec (ipairs tool-specs)]
    ;; Same exposure policy as fen's kernel builtin-tools: the core file
    ;; surface is always provider-visible, not gated behind tool_search.
    (set spec.exposure :always)
    (api.register :tool spec))
  true)

M
