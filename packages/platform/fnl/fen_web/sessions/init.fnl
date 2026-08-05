;; First-party kv session backend registration.
;;
;; `session-backend` is a privileged register kind (not in fen's
;; public-register-kind? allowlist) — this module registers it as
;; embedded-first-party fen-web platform code, the same precedent
;; `fen/extensions/adapters/presenters/web/manifest.fnl` sets for the
;; server-side web presenter (see docs/architecture/seams.md's
;; "Installation pattern"): it runs with the loader's own privileged api,
;; not as a sandboxed third-party extension.
;;
;; The `host.kv` table this binds against is resolved at register time
;; from `_G.__fen_host.kv` (installed by packages/runtime's bootstrap,
;; same mechanism the fetch backend documents at the top of
;; packages/bindings/fnl/fen/util/http/backends/fetch.fnl). Busted tests
;; do not go through M.register at all — they call
;; `fen_web.sessions.kv_session.new` directly with a table-backed stub, so
;; this file stays a thin registration shim with no branching logic of
;; its own to test, except the sync-capability guard below.
;;
;; kv_session.fnl's whole design assumes get/put/delete/list return
;; synchronously (docs/bindings/kv.md's HostKv is Promise-based). Nothing
;; here can tell a Promise apart from a legitimate opaque value kv might
;; one day return, so instead of guessing at the shape of a pending
;; thenable, registration requires an explicit `kv.sync = true` capability
;; flag. A table-backed test kv sets it; the real async IndexedDbKv does
;; not (until packages/runtime grows the coroutine bridge described
;; above), so trying to register straight off `host.kv` today fails loudly
;; here instead of this module silently treating a Promise object as a
;; JSON string deep inside read-meta/read-entries.

(local kv-session (require :fen_web.sessions.kv_session))

(local M {})

(fn assert-sync-kv! [kv]
  (when (not= kv.sync true)
    (error (.. "fen_web.sessions: kv sync bridge not available yet -- "
               "host.kv is async (see docs/bindings/kv.md); this backend "
               "needs a kv table with `sync = true` (a synchronous "
               "adapter or packages/runtime's coroutine bridge once it "
               "lands), not the raw Promise-based HostKv")))
  kv)

(fn host-kv []
  (assert-sync-kv!
    (or (and _G.__fen_host _G.__fen_host.kv)
        (error "fen_web.sessions: __fen_host.kv is not installed"))))

(fn M.register [api]
  (let [backend (kv-session.new (host-kv))]
    (api.register
      :session-backend
      {:name :kv
       :description "Session backend over host.kv (IndexedDB in the browser, a table-backed stub in tests)."
       :open backend.open
       :open-existing backend.open-existing
       :append backend.append
       :append-entry backend.append-entry
       :create backend.create
       :close backend.close
       :load backend.load
       :find backend.find
       :list backend.list
       :latest backend.latest
       :get backend.get
       :doctor backend.doctor
       :acquire-lock backend.acquire-lock
       :latest-extension-state backend.latest-extension-state
       :info backend.info}))
  true)

M
