;; First-load starter-project seeding (fen-web#9).
;;
;; Open question from fen#99: ship a curated starter project into IndexedDB on
;; first load, or boot empty? Resolved in favor of seeding a small todo app —
;; the issue itself notes a seeded project makes the preview-driving loop
;; demoable in one click (the agent can immediately preview.refresh and drive
;; the app it was handed). See docs/apps/demo.md.
;;
;; This is application policy (WHICH files, WHEN to seed), so it lives in
;; Fennel — the starter files themselves are real, reviewable source under
;; apps/demo/starter/ (index.html + app.js + styles.css), bundled to raw text
;; and staged into the VM by boot.ts (the same delivery shape as the fetch
;; backend source). The bytes are written into the "fs:" vfs keyspace through
;; the ordinary fen_web.tools.vfs mechanism — no new persistence path.
;;
;; SEED-ONCE invariant: seeding runs only when the vfs is empty (a genuine
;; first load). Any file already under "fs:" means the user (or a prior seed)
;; has content there, so a later load never clobbers their work. Session data
;; lives under a different keyspace, so a returning user with a conversation
;; but no files would re-seed — which is the intended one-time starter, not a
;; clobber.

(local vfs (require :fen_web.tools.vfs))

(local M {})

;; @doc fen_web.demo.seed.empty?
;; kind: function
;; signature: (empty? kv) -> boolean
;; summary: True when the vfs keyspace holds no files — the first-load condition that gates seeding. Walks the vfs root through fen_web.tools.vfs (the "fs:" keyspace) rather than inspecting kv keys directly, so the empty test uses the same path-semantics mechanism every other file op does.
;; tags: demo seed vfs first-load
(fn M.empty? [kv]
  (let [(files _err) (vfs.walk kv "/")]
    (or (not files) (= (length files) 0))))

;; @doc fen_web.demo.seed.seed!
;; kind: function
;; signature: (seed! kv files) -> count
;; summary: Write every {path content} pair of the starter project into the vfs via fen_web.tools.vfs.write-file (parent dirs are implicit), returning the number of files written. Errors loudly if any write fails rather than leaving a half-seeded workspace silently. Unconditional — callers gate on empty? / use seed-if-empty!.
;; tags: demo seed vfs write
(fn M.seed! [kv files]
  (var n 0)
  (each [path content (pairs (or files {}))]
    (let [(ok? err) (vfs.write-file kv path content)]
      (when (not ok?)
        (error (.. "fen_web.demo.seed: failed to write " (tostring path)
                   ": " (tostring err))))
      (set n (+ n 1))))
  n)

;; @doc fen_web.demo.seed.seed-if-empty!
;; kind: function
;; signature: (seed-if-empty! kv files) -> seeded?
;; summary: Seed the starter project only on a genuine first load (empty? kv), returning true when it wrote the files and false when the vfs already had content (never clobbering user work on later loads). This is the single entry point boot.fnl calls after installing the fs_kv shim.
;; tags: demo seed vfs first-load once
(fn M.seed-if-empty! [kv files]
  (if (M.empty? kv)
      (do (M.seed! kv files) true)
      false))

M
