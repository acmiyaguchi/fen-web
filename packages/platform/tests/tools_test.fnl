;; Tests for the browser file tools (fen_web.tools.{read,write,edit,grep,
;; find,ls}) against a table-backed host.kv installed at _G.__fen_host.kv
;; (packages/platform/tests/support.fnl), and for fen_web.tools.init's
;; registration entry point.

(local support (require :support))
(local read-tool (require :fen_web.tools.read))
(local write-tool (require :fen_web.tools.write))
(local edit-tool (require :fen_web.tools.edit))
(local grep-tool (require :fen_web.tools.grep))
(local find-tool (require :fen_web.tools.find))
(local ls-tool (require :fen_web.tools.ls))
(local tools (require :fen_web.tools))

(fn text-of [result]
  (. result.content 1 :text))

(describe "fen-web browser file tools"
  (fn []
    (var kv nil)

    (before_each
      (fn []
        (set kv (support.make-kv))
        (set _G.__fen_host {:kv kv})))

    (after_each (fn [] (set _G.__fen_host nil)))

    (describe "read"
      (fn []
        (it "write-then-read round trip via the write and read tools"
          (fn []
            (let [w (write-tool.execute {:path "/a.txt" :content "hello"} {})]
              (assert.is_false w.is-error?)
              (assert.is_truthy (string.find (text-of w) "wrote 5 bytes")))
            (let [r (read-tool.execute {:path "/a.txt"} {})]
              (assert.is_false r.is-error?)
              (assert.are.equal "hello" (text-of r)))))

        (it "errors on a missing file"
          (fn []
            (let [r (read-tool.execute {:path "/missing.txt"} {})]
              (assert.is_true r.is-error?)
              (assert.is_truthy (string.find (text-of r) "^error:")))))

        (it "supports offset/limit line windows"
          (fn []
            (write-tool.execute {:path "/lines.txt" :content "a\nb\nc\nd"} {})
            (let [r (read-tool.execute {:path "/lines.txt" :offset 2 :limit 2} {})]
              (assert.are.equal "b\nc" (text-of r)))))

        (it "supports batched reads via paths"
          (fn []
            (write-tool.execute {:path "/x.txt" :content "X"} {})
            (write-tool.execute {:path "/y.txt" :content "Y"} {})
            (let [r (read-tool.execute {:paths ["/x.txt" "/y.txt"]} {})
                  out (text-of r)]
              (assert.is_truthy (string.find out "==> /x.txt <==" 1 true))
              (assert.is_truthy (string.find out "X" 1 true))
              (assert.is_truthy (string.find out "==> /y.txt <==" 1 true))
              (assert.is_truthy (string.find out "Y" 1 true)))))

        (it "rejects a path that escapes the virtual root"
          (fn []
            (let [r (read-tool.execute {:path "/../../etc/passwd"} {})]
              (assert.is_true r.is-error?))))))

    (describe "edit"
      (fn []
        (it "applies a unique exact-text replacement"
          (fn []
            (write-tool.execute {:path "/e.txt" :content "foo bar baz"} {})
            (let [r (edit-tool.execute
                      {:path "/e.txt"
                       :edits [{:old_string "bar" :new_string "QUX"}]}
                      {})]
              (assert.is_false r.is-error?))
            (let [r (read-tool.execute {:path "/e.txt"} {})]
              (assert.are.equal "foo QUX baz" (text-of r)))))

        (it "fails when old_string is not unique, and does not write the file"
          (fn []
            (write-tool.execute {:path "/dup.txt" :content "foo foo"} {})
            (let [r (edit-tool.execute
                      {:path "/dup.txt"
                       :edits [{:old_string "foo" :new_string "bar"}]}
                      {})]
              (assert.is_true r.is-error?)
              (assert.is_truthy (string.find (text-of r) "not unique" 1 true)))
            (let [r (read-tool.execute {:path "/dup.txt"} {})]
              (assert.are.equal "foo foo" (text-of r)))))

        (it "fails when old_string is missing entirely"
          (fn []
            (write-tool.execute {:path "/m.txt" :content "abc"} {})
            (let [r (edit-tool.execute
                      {:path "/m.txt"
                       :edits [{:old_string "zzz" :new_string "y"}]}
                      {})]
              (assert.is_true r.is-error?)
              (assert.is_truthy (string.find (text-of r) "not found" 1 true)))))

        (it "old_string is matched as plain text, not a Lua pattern, even with pattern magic characters"
          (fn []
            ;; old_string here contains %, (, ), ., -- all Lua pattern
            ;; magic characters. If find-all ever matched it as a
            ;; pattern instead of plain text, this either wouldn't match
            ;; at all or would match something other than the literal
            ;; text below. Pins that string.find is always called with
            ;; plain=true for old_string search.
            (write-tool.execute {:path "/magic.txt"
                                  :content "cost: 100% (was (foo).bar) done"}
                                 {})
            (let [r (edit-tool.execute
                      {:path "/magic.txt"
                       :edits [{:old_string "100% (was (foo).bar)"
                                :new_string "REPLACED"}]}
                      {})]
              (assert.is_false r.is-error?))
            (let [r (read-tool.execute {:path "/magic.txt"} {})]
              (assert.are.equal "cost: REPLACED done" (text-of r)))))

        (it "batch files edits are all-or-nothing on validation failure"
          (fn []
            (write-tool.execute {:path "/f1.txt" :content "one"} {})
            (write-tool.execute {:path "/f2.txt" :content "two two"} {})
            (let [r (edit-tool.execute
                      {:files [{:path "/f1.txt"
                                :edits [{:old_string "one" :new_string "ONE"}]}
                               {:path "/f2.txt"
                                :edits [{:old_string "two" :new_string "TWO"}]}]}
                      {})]
              (assert.is_true r.is-error?))
            ;; f1 must be untouched even though its own edit was valid.
            (let [r (read-tool.execute {:path "/f1.txt"} {})]
              (assert.are.equal "one" (text-of r)))))))

    (describe "grep"
      (fn []
        (before_each
          (fn []
            (write-tool.execute {:path "/src/a.fnl" :content "(local x 1)\n(local y 2)\n"} {})
            (write-tool.execute {:path "/src/b.fnl" :content "(fn hello [] x)\n"} {})
            (write-tool.execute {:path "/src/notes.txt" :content "local variable notes\n"} {})))

        (it "finds literal matches across a small tree with path:line:content"
          (fn []
            (let [r (grep-tool.execute {:pattern "local" :path "/src" :literal true} {})
                  out (text-of r)]
              (assert.is_false r.is-error?)
              (assert.is_truthy (string.find out "/src/a.fnl:1:" 1 true))
              (assert.is_truthy (string.find out "/src/notes.txt:1:" 1 true))
              (assert.is_falsy (string.find out "/src/b.fnl" 1 true)))))

        (it "filters by glob"
          (fn []
            (let [r (grep-tool.execute {:pattern "x" :path "/src" :glob "*.fnl" :literal true} {})
                  out (text-of r)]
              (assert.is_truthy (string.find out "/src/a.fnl" 1 true))
              (assert.is_truthy (string.find out "/src/b.fnl" 1 true))
              (assert.is_falsy (string.find out "notes.txt" 1 true)))))

        (it "searching a single file path only searches that file"
          (fn []
            (let [r (grep-tool.execute {:pattern "local" :path "/src/a.fnl" :literal true} {})
                  out (text-of r)]
              (assert.is_truthy (string.find out "/src/a.fnl:1:" 1 true))
              (assert.is_truthy (string.find out "/src/a.fnl:2:" 1 true)))))

        (it "requires a pattern"
          (fn []
            (let [r (grep-tool.execute {:path "/src"} {})]
              (assert.is_true r.is-error?))))))

    (describe "find"
      (fn []
        (it "locates files by name glob recursively"
          (fn []
            (write-tool.execute {:path "/proj/a.fnl" :content "x"} {})
            (write-tool.execute {:path "/proj/sub/b.fnl" :content "x"} {})
            (write-tool.execute {:path "/proj/c.txt" :content "x"} {})
            (let [r (find-tool.execute {:pattern "*.fnl" :path "/proj"} {})
                  out (text-of r)]
              (assert.is_truthy (string.find out "/proj/a.fnl" 1 true))
              (assert.is_truthy (string.find out "/proj/sub/b.fnl" 1 true))
              (assert.is_falsy (string.find out "c.txt" 1 true)))))))

    (describe "ls"
      (fn []
        (it "lists immediate directory entries with bare names (no trailing / on dirs, matching fen's `ls -1`)"
          (fn []
            (write-tool.execute {:path "/d/one.txt" :content "1"} {})
            (write-tool.execute {:path "/d/two.txt" :content "2"} {})
            (write-tool.execute {:path "/d/sub/three.txt" :content "3"} {})
            (let [r (ls-tool.execute {:path "/d"} {})
                  out (text-of r)]
              (assert.are.equal "one.txt\nsub\ntwo.txt" out))))

        (it "ls of a file path prints just that file's name (POSIX behavior)"
          (fn []
            (write-tool.execute {:path "/d/only.txt" :content "1"} {})
            (let [r (ls-tool.execute {:path "/d/only.txt"} {})]
              (assert.is_false r.is-error?)
              (assert.are.equal "only.txt" (text-of r)))))))

    (describe "init registration"
      (fn []
        (it "registers read/write/edit/grep/find/ls with :always exposure"
          (fn []
            (let [registered []
                  api {:register (fn [kind spec] (table.insert registered [kind spec]))}]
              (tools.register api)
              (assert.are.equal 6 (length registered))
              (let [names {}]
                (each [_ [kind spec] (ipairs registered)]
                  (assert.are.equal :tool kind)
                  (assert.are.equal :always spec.exposure)
                  (tset names spec.name true))
                (each [_ n (ipairs [:read :write :edit :grep :find :ls])]
                  (assert.is_true (. names n)))))))))))
