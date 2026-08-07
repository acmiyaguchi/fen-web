;; Search-gated in-VM Fennel evaluation for the browser agent.
;;
;; The agent already executes inside this Wasmoon VM, so this tool adds a
;; capability rather than a new trust boundary. Evaluation still gets a fresh
;; environment for every call: global assignments stay in that scratch table,
;; and fen's runtime tables, registry, and host bridge are not ambient names.
;; The only host capability deliberately supplied is a small vfs facade over
;; host.kv. It keeps raw host methods and non-JSON values out of eval results.

(local fennel (require :fennel))
(local json (require :fen.util.json))
(local util (require :fen_web.tools.util))
(local helpers (require :fen_web.tools.fennel_eval_helpers))

(local DEFAULT-MAX-BYTES 65536)
(local MAX-EXECUTION-STEPS 100000)

(fn max-bytes [args]
  (let [raw (?. args :max_bytes)]
    (if (= raw nil)
        {:limit DEFAULT-MAX-BYTES}
        (let [n (tonumber raw)]
          (if (or (not n) (~= n n))
              (error "max_bytes must be numeric" 0)
              (= n (- math.huge))
              (error "max_bytes must be finite or math.huge" 0)
              (= n math.huge)
              {:limit math.huge}
              ;; Keep a useful result for zero and negative caller values;
              ;; retain a note so an eventual size error explains the clamp.
              (< n 1)
              {:limit 1 :note "clamped to 1"}
              {:limit (math.floor n)})))))

(fn size-limit-error [max-bytes ?note]
  (error (.. "JSON result exceeds max_bytes (" (tostring max-bytes)
             " bytes"
             (if ?note (.. "; " ?note) "")
             "); increase max_bytes") 0))

(fn string-json-size [text]
  ;; Use a cheap lower bound rather than scanning every byte. cjson's exact
  ;; encoded length is checked below.
  (+ 2 (length text)))

(fn preflight-value [value max-bytes ?note]
  "Reject obvious oversized, cyclic, or non-JSON values before cjson builds a
   complete encoded string. Table punctuation is intentionally not included
   in the estimate, so the final exact length check remains authoritative."
  (var estimated-size 0)
  (let [active {}]
    (fn add-size [amount]
      (set estimated-size (+ estimated-size amount))
      (when (> estimated-size max-bytes)
        (size-limit-error max-bytes ?note)))
    (fn visit [item]
      (let [kind (type item)]
        (if (= kind :nil)
            (add-size 4)
            (= kind :boolean)
            (add-size (if item 4 5))
            (= kind :number)
            (add-size (length (tostring item)))
            (= kind :string)
            (add-size (string-json-size item))
            (= kind :table)
            (if (. active item)
                (error "cyclic value cannot be encoded as JSON" 0)
                (do
                  (tset active item true)
                  (add-size 2)
                  (each [key child (pairs item)]
                    ;; Numeric keys are array indexes and are not emitted in
                    ;; JSON. String keys are emitted and therefore counted;
                    ;; cjson remains authoritative for unusual key types.
                    (when (= (type key) :string)
                      (visit key))
                    (visit child))
                  (tset active item nil)))
            (= kind :userdata)
            (if (= item json.null)
                (add-size 4)
                (error "value of type userdata is not JSON serializable" 0))
            (error (.. "value of type " (tostring kind)
                       " is not JSON serializable") 0))))
    (visit value)
    true))

(fn encode-value [value max-bytes ?note]
  (preflight-value value max-bytes ?note)
  ;; Truncating JSON would turn a valid result into invalid JSON. Fail
  ;; cleanly instead and let the caller request a larger bound.
  (let [encoded (json.encode value)]
    (when (> (length encoded) max-bytes)
      (size-limit-error max-bytes ?note))
    encoded))

(fn with-step-limit [thunk]
  ;; The inner pcall lets us clear the hook before re-raising. The outer pcall
  ;; in execute then turns this ordinary Lua error into a tool error.
  (let [(previous-hook previous-mask previous-count) (debug.gethook)
        hook (fn [] (error "execution step limit exceeded" 0))]
    (debug.sethook hook "" MAX-EXECUTION-STEPS)
    (let [(ok? value-or-error) (pcall thunk)]
      ;; Clear first so cleanup itself cannot be interrupted by the limit.
      (debug.sethook)
      (when previous-hook
        (debug.sethook previous-hook previous-mask previous-count))
      (if ok?
          value-or-error
          (error value-or-error 0)))))

;; @doc fen_web.tools.fennel_eval.execute
;; kind: function
;; signature: (execute args ctx ?yield-fn) -> AgentToolResult
;; summary: Evaluate one Fennel expression in a fresh scratch environment and return its value as JSON text; syntax, runtime, and JSON serialization failures are tool errors.
;; tags: tools fennel eval json vfs
(fn execute [args ctx ?yield-fn]
  (if (or (not args) (not args.expr) (= args.expr ""))
      (util.err "missing 'expr'")
      (let [(ok? value-or-error)
            (pcall
              (fn []
                (let [options (max-bytes args)
                      max-bytes options.limit
                      max-bytes-note options.note
                      kv (util.get-kv)
                      value (with-step-limit
                              (fn []
                                (fennel.eval args.expr
                                             {:env (helpers.scratch-env
                                                     kv ctx ?yield-fn)
                                              :filename "fennel_eval"})))]
                  ;; fennel.eval is intentionally consumed in a single value
                  ;; position: extra values from (values ...) are dropped at
                  ;; the tool JSON boundary. Result sizing and encoding happen
                  ;; after the user step hook is cleared.
                  (encode-value value max-bytes max-bytes-note))))]
        (if ok?
            (util.ok value-or-error)
            (util.err (.. "fennel_eval: " (tostring value-or-error)))))))

{:name :fennel_eval
 :label "Fennel Eval"
 :snippet "Run Fennel calculations and batch VFS operations"
 :exposure :search
 :description "Evaluate a Fennel expression in the same Wasmoon VM using a fresh scratch environment. Standard math/string/table helpers are available, plus an explicit host.vfs facade for batch reads and writes over the browser host.kv virtual filesystem. Fen internals, raw __fen_host, require, and process/filesystem globals are not ambiently available. The single return value is JSON text; extra return values from (values ...) are dropped. Syntax errors, runtime errors, non-serializable values, and oversized JSON results are clean tool errors. This is an agent escape hatch, not a security sandbox: the agent already controls this VM."
 :parameters {:type :object
              :properties {:expr {:type :string
                                  :description "Fennel expression to evaluate"
                                  }
                           :max_bytes {:type :integer
                                       :minimum 1
                                       :description "Maximum JSON result bytes (default 65536); oversized results return an error rather than invalid truncated JSON"}}
              :required [:expr]}
 :execute execute}
