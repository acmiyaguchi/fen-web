;; Extension manifest for fen-web's browser file/workspace tools, in the
;; same shape as fen's builtin-tools manifest. The entry module receives the
;; optional web boot opts so web_fetch can remain disabled by default.

{:name :fen_web_tools
 :description "Browser-native workspace tools over host.kv, search-gated fennel_eval over an explicit VFS facade, plus opt-in web_fetch over host.fetch."
 :entry-module :fen_web.tools
 :reload-modules [:fen_web.tools.vfs
                  :fen_web.tools.util
                  :fen_web.tools.path_ops
                  :fen_web.tools.fennel_eval_helpers
                  :fen_web.tools.truncate
                  :fen_web.tools.glob
                  :fen_web.tools.read
                  :fen_web.tools.write
                  :fen_web.tools.edit
                  :fen_web.tools.grep
                  :fen_web.tools.find
                  :fen_web.tools.ls
                  :fen_web.tools.delete
                  :fen_web.tools.move
                  :fen_web.tools.tool_search
                  :fen_web.tools.fennel_eval
                  :fen_web.tools.web_fetch
                  :fen_web.tools]}
