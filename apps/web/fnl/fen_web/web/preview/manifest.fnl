;; Extension manifest for the fen-web demo preview tools (fen-web#8), in the
;; same shape as fen's builtin-tools / the fen-web file-tools manifest
;; (packages/platform/fnl/fen_web/tools/manifest.fnl). Loaded via the per-owner
;; loader (fen_web.web.boot.load-extension!) so owner cleanup and reload apply
;; to the preview.* tools too. This is a demo-only extension: it registers the
;; tools that let the agent drive the sandboxed preview iframe it renders from
;; the IndexedDB virtual FS.

{:name :fen_web_web_preview
 :description "Demo-only preview.* tools driving the sandboxed iframe over host.preview (fen-web#8)."
 :entry-module :fen_web.web.preview
 :reload-modules [:fen_web.web.preview.html
                  :fen_web.web.preview]}
