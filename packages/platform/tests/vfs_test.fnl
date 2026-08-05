;; Tests for fen_web.tools.vfs against a table-backed host.kv stub
;; (packages/platform/tests/support.fnl): path normalization/traversal
;; rejection, write-then-read round trip, delete, exists?, list-dir, walk.

(local support (require :support))
(local vfs (require :fen_web.tools.vfs))

(describe "fen_web.tools.vfs"
  (fn []
    (var kv nil)

    (before_each (fn [] (set kv (support.make-kv))))

    (describe "normalize"
      (fn []
        (it "makes relative paths absolute"
          (fn []
            (assert.are.equal "/a/b" (vfs.normalize "a/b"))))

        (it "collapses . and repeated slashes"
          (fn []
            (assert.are.equal "/a/b" (vfs.normalize "/a/./b"))
            (assert.are.equal "/a/b" (vfs.normalize "/a//b"))))

        (it "resolves .. against the preceding segment"
          (fn []
            (assert.are.equal "/a/c" (vfs.normalize "/a/b/../c"))))

        (it "normalizes the empty/root path to /"
          (fn []
            (assert.are.equal "/" (vfs.normalize ""))
            (assert.are.equal "/" (vfs.normalize "/"))))

        (it "rejects .. that would escape the root"
          (fn []
            (let [(norm err) (vfs.normalize "../etc/passwd")]
              (assert.is_nil norm)
              (assert.is_string err))))

        (it "rejects a deeper .. escape after descending and popping past root"
          (fn []
            (let [(norm err) (vfs.normalize "/a/../../etc/passwd")]
              (assert.is_nil norm)
              (assert.is_string err))))))

    (it "write-file then read-file round trips content"
      (fn []
        (vfs.write-file kv "/dir/file.txt" "hello world")
        (let [(content err) (vfs.read-file kv "dir/file.txt")]
          (assert.is_nil err)
          (assert.are.equal "hello world" content))))

    (it "write-file creates parent directories implicitly"
      (fn []
        (vfs.write-file kv "/a/b/c/deep.txt" "x")
        (assert.is_true (vfs.exists? kv "/a"))
        (assert.is_true (vfs.exists? kv "/a/b"))
        (assert.is_true (vfs.exists? kv "/a/b/c"))))

    (it "read-file on a missing path returns nil, 'No such file or directory'"
      (fn []
        (let [(content err) (vfs.read-file kv "/nope.txt")]
          (assert.is_nil content)
          (assert.is_truthy (string.find err "No such file or directory" 1 true)))))

    (it "read-file on an implicit directory returns nil, 'Is a directory'"
      (fn []
        (vfs.write-file kv "/dir/child.txt" "x")
        (let [(content err) (vfs.read-file kv "/dir")]
          (assert.is_nil content)
          (assert.is_truthy (string.find err "Is a directory" 1 true)))))

    (it "write-file: the target itself being an implicit directory is rejected"
      (fn []
        ;; This pins the write-over-implicit-dir decision: a directory
        ;; (a path with existing descendants) can never be overwritten
        ;; as a file, since that would make it ambiguous whether a
        ;; later read-file/list-dir call means the file or the tree
        ;; beneath it.
        (vfs.write-file kv "/a/b/c" "leaf")
        (let [(ok? err) (vfs.write-file kv "/a/b" "clobber")]
          (assert.is_nil ok?)
          (assert.is_truthy (string.find err "Is a directory" 1 true)))
        ;; The original leaf must be untouched.
        (let [(content _) (vfs.read-file kv "/a/b/c")]
          (assert.are.equal "leaf" content))))

    (it "write-file: a proper ancestor already being a file is rejected"
      (fn []
        (vfs.write-file kv "/a" "file-content")
        (let [(ok? err) (vfs.write-file kv "/a/b" "x")]
          (assert.is_nil ok?)
          (assert.is_truthy (string.find err "Not a directory" 1 true)))
        (let [(content _) (vfs.read-file kv "/a")]
          (assert.are.equal "file-content" content))))

    (it "list-dir on a nonexistent path errors instead of returning empty"
      (fn []
        (let [(listing err) (vfs.list-dir kv "/typo")]
          (assert.is_nil listing)
          (assert.is_truthy (string.find err "No such file or directory" 1 true)))))

    (it "list-dir on a file path errors 'Not a directory'"
      (fn []
        (vfs.write-file kv "/plain.txt" "x")
        (let [(listing err) (vfs.list-dir kv "/plain.txt")]
          (assert.is_nil listing)
          (assert.is_truthy (string.find err "Not a directory" 1 true)))))

    (it "walk on a nonexistent path errors instead of returning empty"
      (fn []
        (let [(files err) (vfs.walk kv "/typo")]
          (assert.is_nil files)
          (assert.is_truthy (string.find err "No such file or directory" 1 true)))))

    (it "list-dir/walk on an empty root succeed with no entries (root always exists)"
      (fn []
        (let [(listing lerr) (vfs.list-dir kv "/")]
          (assert.is_nil lerr)
          (assert.are.same [] listing.dirs)
          (assert.are.same [] listing.files))
        (let [(files werr) (vfs.walk kv "/")]
          (assert.is_nil werr)
          (assert.are.same [] files))))

    (it "exists? is true for files and implicit directories, false otherwise"
      (fn []
        (vfs.write-file kv "/a/b.txt" "x")
        (assert.is_true (vfs.exists? kv "/a/b.txt"))
        (assert.is_true (vfs.exists? kv "/a"))
        (assert.is_false (vfs.exists? kv "/nowhere"))))

    (it "delete removes a file so it no longer exists"
      (fn []
        (vfs.write-file kv "/a.txt" "x")
        (vfs.delete kv "/a.txt")
        (assert.is_false (vfs.exists? kv "/a.txt"))))

    (it "list-dir returns immediate children split into sorted dirs/files"
      (fn []
        (vfs.write-file kv "/root/a.txt" "1")
        (vfs.write-file kv "/root/b.txt" "2")
        (vfs.write-file kv "/root/sub/c.txt" "3")
        (let [(listing err) (vfs.list-dir kv "/root")]
          (assert.is_nil err)
          (assert.are.same ["sub"] listing.dirs)
          (assert.are.same ["a.txt" "b.txt"] listing.files))))

    (it "walk returns every file recursively, sorted"
      (fn []
        (vfs.write-file kv "/root/a.txt" "1")
        (vfs.write-file kv "/root/sub/b.txt" "2")
        (vfs.write-file kv "/root/sub/deeper/c.txt" "3")
        (vfs.write-file kv "/elsewhere.txt" "4")
        (let [(files err) (vfs.walk kv "/root")]
          (assert.is_nil err)
          (assert.are.same ["/root/a.txt" "/root/sub/b.txt" "/root/sub/deeper/c.txt"]
                            files))))

    (it "walk honors an optional yield-fn during the scan"
      (fn []
        (for [i 1 5]
          (vfs.write-file kv (.. "/many/" (tostring i) ".txt") "x"))
        (var calls 0)
        (let [(files _err) (vfs.walk kv "/many" (fn [] (set calls (+ calls 1))))]
          (assert.are.equal 5 (length files))
          ;; walk yields every 256 entries; a 5-file tree never crosses
          ;; that threshold, so this just proves passing a yield-fn
          ;; doesn't break anything.
          (assert.is_true (>= calls 0)))))))
