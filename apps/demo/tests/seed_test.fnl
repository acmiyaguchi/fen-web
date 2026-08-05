;; Tests for first-load starter-project seeding (fen-web#9): the seeder writes
;; the curated starter todo app into the vfs ("fs:") keyspace ONLY on a genuine
;; first load (empty vfs), never clobbering user work on later loads, and the
;; seeded entry renders through the existing preview page assembler out of the
;; box.
;;
;; The starter files are real, reviewable source under apps/demo/starter/. This
;; spec reads them straight off the tree (busted runs with cwd at the repo
;; root, the same way the browser bundles them via import.meta.glob and node
;; reads them off disk in bootTurn.test.ts), so it exercises the actual bytes
;; that ship, not a fixture double.

(local seed (require :fen_web.demo.seed))
(local vfs (require :fen_web.tools.vfs))
(local html (require :fen_web.demo.preview.html))

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

(fn read-disk [path]
  (let [f (io.open path :r)]
    (assert f (.. "cannot open " path))
    (let [content (f:read :*a)]
      (f:close)
      content)))

;; The real starter files keyed by absolute vfs path -- the shape boot.ts
;; stages for the seeder (buildStarterFiles in src/starter.ts / disk read in
;; bootTurn.test.ts).
(fn starter-files []
  (let [dir "apps/demo/starter"]
    {"/index.html" (read-disk (.. dir "/index.html"))
     "/app.js" (read-disk (.. dir "/app.js"))
     "/styles.css" (read-disk (.. dir "/styles.css"))}))

(describe "fen-web demo starter seeding"
  (fn []
    (describe "seed-if-empty!"
      (fn []
        (it "seeds the starter project into the vfs on a genuine first load"
          (fn []
            (let [kv (make-kv)
                  files (starter-files)
                  seeded? (seed.seed-if-empty! kv files)]
              (assert.is_true seeded?)
              ;; Every staged file landed under the "fs:" keyspace, readable
              ;; back through the ordinary vfs mechanism.
              (each [path expected (pairs files)]
                (let [(content _err) (vfs.read-file kv path)]
                  (assert.are.equal expected content)))
              ;; ...and only those files (no stray keys, no double-seed).
              (let [(walked _err) (vfs.walk kv "/")]
                (assert.are.equal 3 (length walked))))))

        (it "reports empty? true only before the first seed"
          (fn []
            (let [kv (make-kv)]
              (assert.is_true (seed.empty? kv))
              (seed.seed-if-empty! kv (starter-files))
              (assert.is_false (seed.empty? kv)))))

        (it "never clobbers user work when the vfs is already non-empty"
          (fn []
            (let [kv (make-kv)]
              ;; Simulate a returning user with their own file.
              (vfs.write-file kv "/index.html" "<h1>my work</h1>")
              (let [seeded? (seed.seed-if-empty! kv (starter-files))]
                (assert.is_false seeded?)
                ;; Their content is untouched and no starter siblings appeared.
                (let [(content _err) (vfs.read-file kv "/index.html")]
                  (assert.are.equal "<h1>my work</h1>" content))
                (assert.is_false (vfs.exists? kv "/app.js"))
                (assert.is_false (vfs.exists? kv "/styles.css"))))))))

    (describe "seeded entry renders through the preview page assembler"
      (fn []
        (it "build-page inlines the seeded stylesheet and script out of the box"
          (fn []
            (let [kv (make-kv)]
              (seed.seed-if-empty! kv (starter-files))
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
                (assert.is_nil (string.find page "src=\"app.js\"" 1 true))))))))))
