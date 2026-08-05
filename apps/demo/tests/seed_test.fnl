;; Tests for the first-load starter project (fen-web#9) as it is SEEN by the
;; app: the curated starter todo app, once seeded into the vfs ("fs:")
;; keyspace, renders end-to-end through the sandboxed-preview path the agent
;; drives.
;;
;; The durable seed *mechanism* (atomic, race-safe, all-or-nothing IndexedDB
;; commit gated on a seed-complete marker) lives in the JS/durable layer after
;; PR #27's review, because the recheck of persistent state and the atomic
;; conditional batch both need async IndexedDB the Lua coroutine cannot await;
;; it is covered by packages/bindings/src/kv/starterSeed.test.ts (validation,
;; empty-seed, idempotence, no-clobber) and exercised end-to-end in
;; apps/demo/src/bootTurn.test.ts. What THIS Fennel spec owns is the app-facing
;; contract that couldn't be checked before: the seeded bytes, written into the
;; same "fs:" keyspace the seeder targets, assemble and render through
;; preview.refresh / build-page out of the box.
;;
;; The starter files are real, reviewable source under apps/demo/starter/. This
;; spec reads them straight off the tree (busted runs with cwd at the repo
;; root, the same bytes the browser bundles and node reads in bootTurn.test.ts),
;; so it exercises the actual bytes that ship, not a fixture double.

(local vfs (require :fen_web.tools.vfs))
(local html (require :fen_web.demo.preview.html))
(local preview (require :fen_web.demo.preview))

;; A table-backed host.kv (same shape as preview_test.fnl / the platform
;; support make-kv): the vfs reads/writes "fs:"-prefixed keys through it.
(fn make-kv []
  (let [store {}]
    {:get (fn [key] (. store key))
     :put (fn [key value] (tset store key value) nil)
     :delete (fn [key] (tset store key nil) nil)
     :list (fn [prefix]
             (let [prefix (or prefix "")
                   keys []]
               (each [k _ (pairs store)]
                 (when (= (string.sub k 1 (length prefix)) prefix)
                   (table.insert keys k)))
               (table.sort keys)
               keys))
     :__store store}))

;; A synchronous host.preview double: records the last set-html page (the way
;; packages/bindings/src/preview/fakePreview.ts does for node tests). refresh
;; only needs set-html; the RPC surface is covered by preview_test.fnl.
(fn make-preview []
  (let [h {:html nil}]
    (set h.preview_set_html (fn [page] (set h.html page)))
    h))

(fn install-host! [kv prev]
  (let [host {:kv kv}]
    (when prev (set host.preview_set_html prev.preview_set_html))
    (set _G.__fen_host host)
    host))

(fn read-disk [path]
  (let [f (io.open path :r)]
    (assert f (.. "cannot open " path))
    (let [content (f:read :*a)]
      (f:close)
      content)))

;; The real starter files keyed by absolute vfs path -- the shape the seeder
;; commits (buildStarterFiles in src/starter.ts / disk read in bootTurn.test.ts).
(fn starter-files []
  (let [dir "apps/demo/starter"]
    {"/index.html" (read-disk (.. dir "/index.html"))
     "/app.js" (read-disk (.. dir "/app.js"))
     "/styles.css" (read-disk (.. dir "/styles.css"))}))

;; Seed a table kv the way the durable seeder does: write each starter file
;; into the "fs:" keyspace through the ordinary vfs mechanism.
(fn seed-vfs! [kv]
  (each [path content (pairs (starter-files))]
    (assert (vfs.write-file kv path content))))

;; Fetch a registered preview tool by name.
(fn tool-named [name]
  (var t nil)
  (preview.register
    {:register (fn [_ s] (when (= s.name name) (set t s)))})
  (assert t (.. "tool not registered: " (tostring name)))
  t)

(describe "fen-web demo starter project"
  (fn []
    (after_each (fn [] (set _G.__fen_host nil)))

    (describe "seeded entry renders through build-page"
      (fn []
        (it "inlines the seeded stylesheet and script out of the box"
          (fn []
            (let [kv (make-kv)]
              (seed-vfs! kv)
              ;; The default preview entry (/index.html) resolves and its
              ;; same-tree references inline into one self-contained document.
              (let [(page found?) (html.build-page kv "/index.html")]
                (assert.is_true found?)
                (assert.is_truthy (string.find page "<title>Starter todo</title>" 1 true))
                ;; styles.css inlined (external <link> gone)
                (assert.is_truthy (string.find page "<style>" 1 true))
                (assert.is_nil (string.find page "href=\"styles.css\"" 1 true))
                ;; app.js inlined (external <script src> gone)
                (assert.is_truthy (string.find page "window.todoApp" 1 true))
                (assert.is_nil (string.find page "src=\"app.js\"" 1 true))))))))

    (describe "seeded entry renders through preview.refresh"
      (fn []
        (it "assembles the seeded app into host.preview via set-html"
          (fn []
            ;; Drive the actual preview.refresh tool (not just build-page) over
            ;; the seeded vfs and the FakePreview-style host, so the whole
            ;; refresh path -- entry resolution, same-tree inlining, and the
            ;; host.preview_set_html hand-off the agent relies on -- is covered,
            ;; not only the page assembler in isolation.
            (let [kv (make-kv)
                  prev (make-preview)]
              (seed-vfs! kv)
              (install-host! kv prev)
              (let [refresh (tool-named :preview.refresh)
                    r (refresh.execute {} {} nil)
                    page prev.html]
                (assert.is_false r.is-error?)
                ;; the assembled page landed in the preview iframe...
                (assert.is_truthy page)
                (assert.is_truthy (string.find page "<title>Starter todo</title>" 1 true))
                ;; ...as one self-contained document (assets inlined, not linked)
                (assert.is_truthy (string.find page "<style>" 1 true))
                (assert.is_truthy (string.find page "window.todoApp" 1 true))
                (assert.is_nil (string.find page "href=\"styles.css\"" 1 true))
                (assert.is_nil (string.find page "src=\"app.js\"" 1 true))
                ;; the interactive controls the preview.* tools drive are present
                (assert.is_truthy (string.find page "id=\"new-todo\"" 1 true))
                (assert.is_truthy (string.find page "id=\"add-todo\"" 1 true))
                ;; and refresh reported it rendered from the seeded entry
                (assert.is_truthy (string.find (. r.content 1 :text) "/index.html" 1 true))))))

        (it "refreshing a specific seeded entry renders that page"
          (fn []
            (let [kv (make-kv)
                  prev (make-preview)]
              (seed-vfs! kv)
              (install-host! kv prev)
              (let [refresh (tool-named :preview.refresh)
                    r (refresh.execute {:entry "/index.html"} {} nil)]
                (assert.is_false r.is-error?)
                (assert.is_truthy (string.find prev.html "Starter todo" 1 true))))))))))
