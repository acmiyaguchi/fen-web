;; Persistent DOM-presenter state (fen-web#6). Held outside the reloadable
;; modules (see manifest.fnl's :reload-exclude) so /reload re-requires the
;; behavior modules while the transcript, status, the committed DOM model,
;; and any in-flight prompt/select survive in-page. Mirrors the TUI/web
;; presenters' state-module split, adapted to host.dom-apply.

;; @doc fen_web.web.state.api
;; kind: data
;; signature: table|nil
;; summary: The extension api handle captured at register time, used by layout to enumerate registered status/panel contributions.
;; tags: demo presenter state api

;; @doc fen_web.web.state.presenter-ctx
;; kind: data
;; signature: table|nil
;; summary: The presenter run context ({on-submit on-tick request-cancel is-busy?}) captured while the run loop is active.
;; tags: demo presenter state lifecycle

;; @doc fen_web.web.state.root-id
;; kind: data
;; signature: string
;; summary: Element id of the mount point the HTML shell provides; the presenter builds its skeleton under it.
;; tags: demo presenter state dom

;; @doc fen_web.web.state.quit?
;; kind: data
;; signature: boolean
;; summary: Run-loop shutdown flag set when the page/session requests presenter teardown.
;; tags: demo presenter state lifecycle

;; @doc fen_web.web.state.transcript
;; kind: data
;; signature: [PresenterEvent]
;; summary: Append-only preprocessed transcript event log, the source of truth the fragment diff renders from.
;; tags: demo presenter state transcript

;; @doc fen_web.web.state.status-info
;; kind: data
;; signature: table
;; summary: Status metadata (provider/model, context estimate, cumulative and per-turn token/cache usage, queue depths, running tool, thinking/cancelling flags, turn timing) folded from bus events.
;; tags: demo presenter state status

;; @doc fen_web.web.state.dom
;; kind: data
;; signature: {:built? boolean :nodes table :children table}
;; summary: Committed DOM model the fragment diff compares against — per-id last text/class (:nodes) and per-parent ordered child ids (:children) — so each frame emits only changed mutations. Persisted across /reload so the diff never re-creates live nodes.
;; tags: demo presenter state dom diff reload

;; @doc fen_web.web.state.select
;; kind: data
;; signature: table|nil
;; summary: Active DOM select prompt ({label choices result done?}) awaited cooperatively by api.ui.select, or nil when none is open.
;; tags: demo presenter state select ui

;; @doc fen_web.web.state.prompt
;; kind: data
;; signature: table|nil
;; summary: Active DOM text prompt ({label result done?}) awaited cooperatively by api.ui.prompt, or nil when none is open.
;; tags: demo presenter state prompt ui

{:api nil
 :presenter-ctx nil
 :root-id "fen-app"
 :quit? false
 :transcript []
 :status-info {:provider nil
               :model nil
               :last-input 0
               :last-output 0
               :last-cache-read 0
               :last-cache-write 0
               :last-usage? false
               :usage-seen? false
               :turn-input 0
               :turn-output 0
               :turn-cache-read 0
               :turn-cache-write 0
               :turn-usage? false
               :cum-input 0
               :cum-output 0
               :cum-cache-read 0
               :cum-cache-write 0
               :approx-context 0
               :context-estimated? true
               :context-source :estimated
               :steering-queued 0
               :follow-up-queued 0
               :running-label nil
               :thinking? false
               :cancelling? false
               :turn-start 0
               :spin-frame 0}
 :dom {:built? false :nodes {} :children {}}
 :select nil
 :prompt nil}
