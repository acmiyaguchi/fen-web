;; Boundary tests for fen_web.tools.truncate.truncate-head, plus the read
;; and grep tools that call it, at exactly DEFAULT-MAX-LINES (2000) /
;; DEFAULT-MAX-BYTES (50KB) and one past each boundary.

(local support (require :support))
(local truncate (require :fen_web.tools.truncate))
(local read-tool (require :fen_web.tools.read))
(local write-tool (require :fen_web.tools.write))
(local grep-tool (require :fen_web.tools.grep))

(fn text-of [result] (. result.content 1 :text))

(fn lines-of-count [n]
  "n short lines ('x'), newline-joined -- (n - 1) newlines, n total lines."
  (let [parts []]
    (for [_ 1 n] (table.insert parts "x"))
    (table.concat parts "\n")))

(describe "fen_web.tools.truncate.truncate-head boundaries"
  (fn []
    (it "content at exactly max-lines is returned unmodified"
      (fn []
        (let [s (lines-of-count truncate.DEFAULT-MAX-LINES)
              (out truncated?) (truncate.truncate-head s)]
          (assert.is_false truncated?)
          (assert.are.equal s out))))

    (it "content one line past max-lines is truncated"
      (fn []
        (let [s (lines-of-count (+ truncate.DEFAULT-MAX-LINES 1))
              (out truncated?) (truncate.truncate-head s)]
          (assert.is_true truncated?)
          (assert.is_truthy (string.find out "[truncated: kept head" 1 true)))))

    (it "content at exactly max-bytes (single line) is returned unmodified"
      (fn []
        (let [s (string.rep "a" truncate.DEFAULT-MAX-BYTES)
              (out truncated?) (truncate.truncate-head s)]
          (assert.is_false truncated?)
          (assert.are.equal s out))))

    (it "content one byte past max-bytes is truncated"
      (fn []
        (let [s (string.rep "a" (+ truncate.DEFAULT-MAX-BYTES 1))
              (out truncated?) (truncate.truncate-head s)]
          (assert.is_true truncated?)
          (assert.is_truthy (string.find out "[truncated: kept head" 1 true)))))

    (it "keeps a byte head for a single-line body with no complete line fit"
      (fn []
        (let [s (string.rep "a" (* 100 1024))
              (out truncated?) (truncate.truncate-head s)]
          (assert.is_true truncated?)
          (assert.are.equal (string.rep "a" truncate.DEFAULT-MAX-BYTES)
                            (string.sub out 1 truncate.DEFAULT-MAX-BYTES))
          (assert.is_truthy (string.find out "[truncated: kept head" 1 true)))))
  ))

(describe "truncation boundary through the read and grep tools"
  (fn []
    (var kv nil)

    (before_each
      (fn []
        (set kv (support.make-kv))
        (set _G.__fen_host {:kv kv})))

    (after_each (fn [] (set _G.__fen_host nil)))

    (it "read: a file at exactly max-lines is not truncated"
      (fn []
        (write-tool.execute {:path "/exact.txt" :content (lines-of-count truncate.DEFAULT-MAX-LINES)} {})
        (let [r (read-tool.execute {:path "/exact.txt"} {})]
          (assert.is_falsy (string.find (text-of r) "[truncated" 1 true)))))

    (it "read: a file one line past max-lines is truncated"
      (fn []
        (write-tool.execute {:path "/over.txt" :content (lines-of-count (+ truncate.DEFAULT-MAX-LINES 1))} {})
        (let [r (read-tool.execute {:path "/over.txt"} {})]
          (assert.is_truthy (string.find (text-of r) "[truncated" 1 true)))))

    (it "grep: single-file match output at exactly max-lines is not truncated"
      (fn []
        ;; Every line matches "x", producing exactly max-lines matched
        ;; output lines (no context, one output line per match).
        (write-tool.execute {:path "/g.txt" :content (lines-of-count truncate.DEFAULT-MAX-LINES)} {})
        (let [r (grep-tool.execute {:pattern "x" :path "/g.txt" :literal true :limit 999999} {})]
          (assert.is_falsy (string.find (text-of r) "[truncated" 1 true)))))

    (it "grep: single-file match output one line past max-lines is truncated"
      (fn []
        (write-tool.execute {:path "/g2.txt" :content (lines-of-count (+ truncate.DEFAULT-MAX-LINES 1))} {})
        (let [r (grep-tool.execute {:pattern "x" :path "/g2.txt" :literal true :limit 999999} {})]
          (assert.is_truthy (string.find (text-of r) "[truncated" 1 true)))))))
