;; Extension manifest for fen-web's browser file-tool extension, in the
;; same shape as fen's builtin-tools manifest
;; (fen/extensions/behaviors/kernel/builtin-tools/manifest.fnl). Not
;; wired into a loader/discover path yet (that's the runtime's later
;; concern) -- this documents the intended entry point and reload set.

{:name :fen_web_tools
 :description "Browser-native read/write/edit/grep/find/ls tools over host.kv, replacing fen's builtin-tools in the browser."
 :entry-module :fen_web.tools
 :reload-modules [:fen_web.tools.vfs
                  :fen_web.tools.util
                  :fen_web.tools.truncate
                  :fen_web.tools.glob
                  :fen_web.tools.read
                  :fen_web.tools.write
                  :fen_web.tools.edit
                  :fen_web.tools.grep
                  :fen_web.tools.find
                  :fen_web.tools.ls
                  :fen_web.tools]}
