;; Direct unit specs for fen_web.shims.fs-kv itself (not routed through a
;; real fen module), covering the blast-radius fixes from the fen-web#15
;; review: valid-but-unsupported io.open modes return nil,err rather than
;; throwing; append mode round-trips; os.getenv is allowlisted to
;; API-key-shaped names; os.execute only reports success for the one
;; command settings.fnl actually issues.

(local support (require :support))
(local fs-kv (require :fen_web.shims.fs_kv))

(describe "fen_web.shims.fs-kv"
  (fn []
    (var kv nil)

    (before_each (fn [] (set kv (support.make-kv))))

    (describe "open"
      (fn []
        (it "r on a missing key returns nil, err (not an error())"
          (fn []
            (let [(f err) (fs-kv.open kv "missing.json" :r)]
              (assert.is_nil f)
              (assert.truthy (string.find err "No such file")))))

        (it "r on an existing key returns the full content via :read('*a')"
          (fn []
            (kv.put "a.txt" "hello")
            (let [(f _err) (fs-kv.open kv "a.txt" :r)]
              (assert.are.equal "hello" (f:read "*a"))
              (f:close))))

        (it "w writes are invisible until :close, then committed"
          (fn []
            (let [(f _err) (fs-kv.open kv "w.txt" :w)]
              (f:write "one")
              (f:write "two")
              (assert.is_nil (kv.get "w.txt"))
              (f:close)
              (assert.are.equal "onetwo" (kv.get "w.txt")))))

        (it "a seeds the buffer from the existing kv value and appends on close"
          (fn []
            (kv.put "log.jsonl" "{\"a\":1}\n")
            (let [(f _err) (fs-kv.open kv "log.jsonl" :a)]
              (f:write "{\"a\":2}\n")
              (f:close))
            (assert.are.equal "{\"a\":1}\n{\"a\":2}\n" (kv.get "log.jsonl"))))

        (it "a on a missing key behaves like a fresh w (seeds from empty)"
          (fn []
            (let [(f _err) (fs-kv.open kv "fresh.jsonl" :a)]
              (f:write "{\"a\":1}\n")
              (f:close))
            (assert.are.equal "{\"a\":1}\n" (kv.get "fresh.jsonl"))))

        (it "rb/wb strip the binary suffix and behave like r/w"
          (fn []
            (kv.put "bin.dat" "bytes")
            (let [(f _err) (fs-kv.open kv "bin.dat" :rb)]
              (assert.are.equal "bytes" (f:read "*a"))
              (f:close))))

        (it "a valid-but-unimplemented mode (r+) returns nil, err instead of throwing"
          (fn []
            (let [(f err) (fs-kv.open kv "x.txt" "r+")]
              (assert.is_nil f)
              (assert.truthy (string.find err "unsupported mode")))))

        (it "a malformed mode string still errors loudly, matching real io.open"
          (fn []
            (assert.has_error #(fs-kv.open kv "x.txt" "bogus"))))

        (it "a write handle's unsupported methods (e.g. :seek) error with a clear message instead of a nil-call crash"
          (fn []
            (let [(f _err) (fs-kv.open kv "w2.txt" :w)]
              (assert.has_error #(f:seek "set" 0)
                                 "fs-kv: write-handle:seek is not supported by the kv-backed shim"))))))

    (describe "remove/rename"
      (fn []
        (it "remove deletes an existing key and no-ops on a missing one"
          (fn []
            (kv.put "r.txt" "x")
            (assert.is_true (fs-kv.remove kv "r.txt"))
            (assert.is_nil (kv.get "r.txt"))
            (assert.is_true (fs-kv.remove kv "r.txt"))))

        (it "rename moves the value and deletes the old key"
          (fn []
            (kv.put "tmp.json" "{}")
            (let [(ok? _err) (fs-kv.rename kv "tmp.json" "final.json")]
              (assert.is_true ok?)
              (assert.is_nil (kv.get "tmp.json"))
              (assert.are.equal "{}" (kv.get "final.json")))))

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

        (it "reports failure (exit 127) for anything else, e.g. rm -rf, instead of lying that it ran"
          (fn []
            (let [(ok? kind code) (fs-kv.execute "rm -rf /")]
              (assert.is_nil ok?)
              (assert.are.equal :exit kind)
              (assert.are.equal 127 code))))))

    (describe "getenv allowlist"
      (fn []
        (it "answers an API-key-shaped name from the env/apikey/ namespace"
          (fn []
            (kv.put "env/apikey/ANTHROPIC_API_KEY" "sk-123")
            (assert.are.equal "sk-123" (fs-kv.getenv kv "ANTHROPIC_API_KEY"))))

        (it "does NOT answer FEN_LOG from kv, even if a value is stored under it"
          (fn []
            (kv.put "env/apikey/FEN_LOG" "debug")
            (assert.is_nil (fs-kv.getenv kv "FEN_LOG"))))

        (it "does NOT answer HOME from kv (path.fnl's home() must keep falling back to /tmp)"
          (fn []
            (kv.put "env/apikey/HOME" "/home/attacker")
            (assert.is_nil (fs-kv.getenv kv "HOME"))))

        (it "does NOT answer other FEN_* debug/dev flags (FEN_DEV_PATH, FEN_TOOL_RESULT_MAX_BYTES)"
          (fn []
            (kv.put "env/apikey/FEN_DEV_PATH" "/evil")
            (kv.put "env/apikey/FEN_TOOL_RESULT_MAX_BYTES" "999999999")
            (assert.is_nil (fs-kv.getenv kv "FEN_DEV_PATH"))
            (assert.is_nil (fs-kv.getenv kv "FEN_TOOL_RESULT_MAX_BYTES"))))

        (it "returns nil for an unset API-key-shaped name without erroring"
          (fn []
            (assert.is_nil (fs-kv.getenv kv "OPENAI_API_KEY"))))))

    (describe "install!/uninstall! lifecycle"
      (fn []
        (it "install! asserts kv has get/put/delete function fields"
          (fn []
            (assert.has_error #(fs-kv.install! {}))
            (assert.has_error #(fs-kv.install! {:get (fn []) :put (fn [])}))))

        (it "install! then uninstall! round-trips os.getenv back to the real implementation"
          (fn []
            (let [snap (fs-kv.snapshot-globals)
                  real-getenv os.getenv]
              (fs-kv.install! kv)
              (assert.is_falsy (= os.getenv real-getenv))
              (fs-kv.uninstall! snap)
              (assert.is_true (= os.getenv real-getenv)))))))))
