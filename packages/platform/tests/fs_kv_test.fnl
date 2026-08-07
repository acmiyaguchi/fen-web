;; Direct unit specs for fen_web.shims.fs-kv's remaining direct-IO surface.
;; Settings/model persistence and API-key lookup now use the v0.17 storage/path
;; seams; the retained fs-kv operations are covered for Codex auth and
;; diagnostic call paths.

(local support (require :support))
(local fs-kv (require :fen_web.shims.fs_kv))

(describe "fen_web.shims.fs-kv retained direct-IO surface"
  (fn []
    (var kv nil)

    (before_each (fn [] (set kv (support.make-kv))))

    (describe "open"
      (fn []
        (it "r on a missing key returns nil, err (Codex read behavior)"
          (fn []
            (let [(f err) (fs-kv.open kv "missing.json" :r)]
              (assert.is_nil f)
              (assert.truthy (string.find err "No such file")))))

        (it "r on an existing key returns the full content"
          (fn []
            (kv.put "auth.json" "hello")
            (let [(f _err) (fs-kv.open kv "auth.json" :r)]
              (assert.are.equal "hello" (f:read "*a"))
              (f:close))))

        (it "w writes are invisible until close, then commit"
          (fn []
            (let [(f _err) (fs-kv.open kv "auth.json.tmp" :w)]
              (f:write "one")
              (f:write "two")
              (assert.is_nil (kv.get "auth.json.tmp"))
              (f:close)
              (assert.are.equal "onetwo" (kv.get "auth.json.tmp")))))

        (it "a seeds the buffer from the existing kv value and appends on close"
          (fn []
            (kv.put "errors.jsonl" "{\"a\":1}\n")
            (let [(f _err) (fs-kv.open kv "errors.jsonl" :a)]
              (f:write "{\"a\":2}\n")
              (f:flush)
              ;; flush is intentionally not a separate kv commit.
              (assert.are.equal "{\"a\":1}\n" (kv.get "errors.jsonl"))
              (f:close))
            (assert.are.equal "{\"a\":1}\n{\"a\":2}\n"
                               (kv.get "errors.jsonl"))))

        (it "a on a missing key seeds from empty (jsonl.append! first write)"
          (fn []
            (let [(f _err) (fs-kv.open kv "fresh.jsonl" :a)]
              (f:write "{\"a\":1}\n")
              (f:close))
            (assert.are.equal "{\"a\":1}\n" (kv.get "fresh.jsonl"))))

        (it "rb/wb strip the binary suffix"
          (fn []
            (kv.put "auth.json" "bytes")
            (let [(f _err) (fs-kv.open kv "auth.json" :rb)]
              (assert.are.equal "bytes" (f:read "*a"))
              (f:close))))

        (it "a valid-but-unimplemented update mode returns nil, err"
          (fn []
            (let [(f err) (fs-kv.open kv "x.txt" "r+")]
              (assert.is_nil f)
              (assert.truthy (string.find err "unsupported mode")))))

        (it "a malformed mode string still errors loudly"
          (fn []
            (assert.has_error #(fs-kv.open kv "x.txt" "bogus"))))

        (it "unsupported handle methods report a clear error"
          (fn []
            (let [(f _err) (fs-kv.open kv "auth.tmp" :w)]
              (assert.has_error #(f:seek "set" 0)
                                 "fs-kv: write-handle:seek is not supported by the kv-backed shim"))))))

    (describe "remove/rename"
      (fn []
        (it "remove deletes an existing key and no-ops on a missing one"
          (fn []
            (kv.put "auth.tmp" "x")
            (assert.is_true (fs-kv.remove kv "auth.tmp"))
            (assert.is_nil (kv.get "auth.tmp"))
            (assert.is_true (fs-kv.remove kv "auth.tmp"))))

        (it "rename moves the value and deletes the old key"
          (fn []
            (kv.put "auth.tmp" "{}")
            (let [(ok? _err) (fs-kv.rename kv "auth.tmp" "auth.json")]
              (assert.is_true ok?)
              (assert.is_nil (kv.get "auth.tmp"))
              (assert.are.equal "{}" (kv.get "auth.json")))))

        (it "rename of a missing source returns nil, err"
          (fn []
            (let [(ok? err) (fs-kv.rename kv "nope.json" "final.json")]
              (assert.is_nil ok?)
              (assert.truthy (string.find err "No such file")))))))

    (describe "execute"
      (fn []
        (it "reports success only for mkdir -p"
          (fn []
            (let [(ok? kind code) (fs-kv.execute "mkdir -p /tmp/.config/fen")]
              (assert.is_true ok?)
              (assert.are.equal :exit kind)
              (assert.are.equal 0 code))))

        (it "reports failure for commands outside the directory no-op"
          (fn []
            (let [(ok? kind code) (fs-kv.execute "rm -rf /")]
              (assert.is_nil ok?)
              (assert.are.equal :exit kind)
              (assert.are.equal 127 code))))))

    (describe "install!/uninstall! lifecycle"
      (fn []
        (it "install! asserts kv has get/put/delete fields"
          (fn []
            (assert.has_error #(fs-kv.install! {}))
            (assert.has_error #(fs-kv.install! {:get (fn []) :put (fn [])}))))

        (it "patches the retained globals and restores them"
          (fn []
            (let [snap (fs-kv.snapshot-globals)
                  real-open io.open
                  real-remove os.remove
                  real-rename os.rename
                  real-execute os.execute
                  real-getenv os.getenv]
              (fs-kv.install! kv)
              (assert.is_falsy (= io.open real-open))
              (assert.is_falsy (= os.remove real-remove))
              (assert.is_falsy (= os.rename real-rename))
              (assert.is_falsy (= os.execute real-execute))
              (assert.is_falsy (= os.getenv real-getenv))
              (assert.is_nil (os.getenv "HOME"))
              (fs-kv.uninstall! snap)
              (assert.is_true (= io.open real-open))
              (assert.is_true (= os.remove real-remove))
              (assert.is_true (= os.rename real-rename))
              (assert.is_true (= os.execute real-execute))
              (assert.is_true (= os.getenv real-getenv)))))))))
