;; Output-size truncation for tool results, ported from fen's
;; extensions/behaviors/kernel/builtin-tools/truncate.fnl.
;;
;; Deliberate divergence from fen's version: fen's truncate-head spills
;; the untruncated output to a file under XDG_STATE_HOME and references
;; that path in the truncation tag so the model can page back through it
;; with offset/limit. There is no local filesystem to spill into here
;; (io.open doesn't exist in the browser Fennel VM) and no `full output:
;; <path>` seam to replace it with yet, so the tag below simply reports
;; what was kept vs. the total and omits the path -- callers that need
;; the rest should re-read with an explicit offset/limit instead.

(local DEFAULT-MAX-LINES 2000)
(local DEFAULT-MAX-BYTES (* 50 1024))
(local LINES-BEFORE-YIELD 512)

(fn maybe-yield [?yield-fn]
  (when ?yield-fn (?yield-fn)))

(fn count-lines [s ?yield-fn]
  (var n 1)
  (var scanned 0)
  (each [_ (string.gmatch s "\n")]
    (set n (+ n 1))
    (set scanned (+ scanned 1))
    (when (and ?yield-fn (>= scanned LINES-BEFORE-YIELD))
      (set scanned 0)
      (?yield-fn)))
  n)

(fn fmt-kb [n]
  (string.format "%dKB" (math.floor (/ n 1024))))

;; @doc fen_web.tools.truncate.truncate-head
;; kind: function
;; signature: (truncate-head s opts? yield-fn?) -> string, truncated?
;; summary: Keep the beginning of tool output within max-lines/max-bytes, yielding during the scan when cooperative; no spill-to-file (browser has no local fs).
;; tags: tools output truncate
(fn truncate-head [s opts ?yield-fn]
  (let [s (or s "")
        max-lines (or (?. opts :max-lines) DEFAULT-MAX-LINES)
        max-bytes (or (?. opts :max-bytes) DEFAULT-MAX-BYTES)
        total-bytes (length s)
        total-lines (count-lines s ?yield-fn)]
    (if (and (<= total-lines max-lines) (<= total-bytes max-bytes))
        (values s false)
        (let [out []]
          (var bytes 0)
          (var lines 0)
          (var scanned 0)
          (var done? false)
          (each [line (string.gmatch (.. s "\n") "([^\n]*)\n") &until done?]
            (set scanned (+ scanned 1))
            (let [llen (+ (length line) 1)]
              (if (or (>= lines max-lines)
                      (> (+ bytes llen) max-bytes))
                  (set done? true)
                  (do (table.insert out line)
                      (set lines (+ lines 1))
                      (set bytes (+ bytes llen)))))
            (when (and ?yield-fn (>= scanned LINES-BEFORE-YIELD))
              (set scanned 0)
              (?yield-fn)))
          (let [content (table.concat out "\n")
                tag (string.format "[truncated: kept head %d/%d lines, %s/%s]"
                                    lines total-lines (fmt-kb (length content))
                                    (fmt-kb total-bytes))]
            (values (.. content "\n" tag) true))))))

{: DEFAULT-MAX-LINES
 : DEFAULT-MAX-BYTES
 : truncate-head}
