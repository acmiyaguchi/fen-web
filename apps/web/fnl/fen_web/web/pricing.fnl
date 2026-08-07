;; Best-effort, manually maintained model pricing for the browser demo.
;; Prices are USD per million tokens and are intentionally keyed by the exact
;; model id so adding a provider/model does not silently apply the wrong rate.
;; Cache multipliers are relative to the ordinary input-token price.

(local DEFAULT-CACHE-READ-MULTIPLIER 0.1)
(local DEFAULT-CACHE-WRITE-MULTIPLIER 1.25)

(local M {})

(local PRICES
  (let [prices {}]
    ;; Anthropic Claude Haiku 4.5 pricing: $1/M input, $5/M output.
    ;; Keep cache multipliers on each entry so a model with different cache
    ;; tiers can override the defaults without changing estimate arithmetic.
    (tset prices "claude-haiku-4-5"
          {:input-per-million 1.0
           :output-per-million 5.0
           :cache-read-multiplier DEFAULT-CACHE-READ-MULTIPLIER
           :cache-write-multiplier DEFAULT-CACHE-WRITE-MULTIPLIER})
    ;; Sonnet 5 / Opus 5 (the other #45 catalog models): $3/$15 and $5/$25
    ;; per Mtok. Same best-effort caveat as above.
    (tset prices "claude-sonnet-5"
          {:input-per-million 3.0
           :output-per-million 15.0
           :cache-read-multiplier DEFAULT-CACHE-READ-MULTIPLIER
           :cache-write-multiplier DEFAULT-CACHE-WRITE-MULTIPLIER})
    (tset prices "claude-opus-5"
          {:input-per-million 5.0
           :output-per-million 25.0
           :cache-read-multiplier DEFAULT-CACHE-READ-MULTIPLIER
           :cache-write-multiplier DEFAULT-CACHE-WRITE-MULTIPLIER})
    prices))

;; @doc fen_web.web.pricing.for-model
;; kind: function
;; signature: (for-model model) -> {:input-per-million :output-per-million :cache-read-multiplier :cache-write-multiplier}|nil
;; summary: Look up best-effort pricing by exact model id; unknown models have no estimate.
;; tags: demo pricing cost cache
(fn M.for-model [model]
  (. PRICES (tostring (or model ""))))

;; @doc fen_web.web.pricing.estimate
;; kind: function
;; signature: (estimate model input output ?cache-read ?cache-write) -> number|nil
;; summary: Estimate USD session cost from ordinary and cached token totals, or return nil for an unknown model.
;; tags: demo pricing cost cache
(fn M.estimate [model input output ?cache-read ?cache-write]
  (let [p (M.for-model model)]
    (when p
      (let [input (or (tonumber input) 0)
            output (or (tonumber output) 0)
            cache-read (or (tonumber ?cache-read) 0)
            cache-write (or (tonumber ?cache-write) 0)
            cache-read-multiplier (or p.cache-read-multiplier
                                      DEFAULT-CACHE-READ-MULTIPLIER)
            cache-write-multiplier (or p.cache-write-multiplier
                                       DEFAULT-CACHE-WRITE-MULTIPLIER)]
        (+ (* (/ input 1000000) p.input-per-million)
           (* (/ output 1000000) p.output-per-million)
           (* (/ cache-read 1000000) p.input-per-million
              cache-read-multiplier)
           (* (/ cache-write 1000000) p.input-per-million
              cache-write-multiplier))))))

;; @doc fen_web.web.pricing.format-cost
;; kind: function
;; signature: (format-cost model input output ?cache-read ?cache-write) -> string|nil
;; summary: Format a model-aware approximate cost estimate, using a sub-cent marker and omitting unknown models.
;; tags: demo pricing cost cache
(fn M.format-cost [model input output ?cache-read ?cache-write]
  (let [cost (M.estimate model input output ?cache-read ?cache-write)]
    (when cost
      (if (< cost 0.001)
          "<$0.001"
          (string.format "~$%.3f" cost)))))

M
