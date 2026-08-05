;; Extension manifest for the fen-web demo DOM presenter (fen-web#6), in the
;; same shape as fen's in-tree TUI/web presenter manifests
;; (fen/extensions/adapters/presenters/{tui,web}/manifest.fnl). The loader
;; owns reload: behavior modules are cleared and re-required, while the
;; persistent presenter state (transcript, status, committed DOM model,
;; in-flight prompt/select) is excluded so /reload never rebuilds live DOM or
;; loses the conversation in-page.

{:name :fen_web_demo
 :description "Browser DOM presenter over host.dom-apply, replacing the termbox2 TUI for apps/demo."
 :entry-module :fen_web.demo
 :interactive-only? true
 :presenter :dom
 :reload-modules [:fen_web.demo.ingest
                  :fen_web.demo.layout
                  :fen_web.demo.dom
                  :fen_web.demo]
 :reload-exclude [:fen_web.demo.state]}
