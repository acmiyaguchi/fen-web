;; Unit tests for the browser presenter's model-aware cost arithmetic.
;; DOM tests only assert whether the cost fragment exists; exact numbers belong
;; here with the pricing table and cache multipliers visible.

(local pricing (require :fen_web.web.pricing))

(describe "fen-web pricing"
  (fn []
    (it "returns a structured exact-model entry with cache multipliers"
      (fn []
        (let [p (pricing.for-model "claude-haiku-4-5")]
          (assert.is_truthy p)
          (assert.are.equal 1.0 p.input-per-million)
          (assert.are.equal 5.0 p.output-per-million)
          (assert.are.equal 0.1 p.cache-read-multiplier)
          (assert.are.equal 1.25 p.cache-write-multiplier))))

    (it "estimates ordinary and cached token arithmetic"
      (fn []
        ;; $0.002 input + $0.005 output + $0.0003 cache-read
        ;; + $0.005 cache-write = $0.0123.
        (let [estimate (pricing.estimate "claude-haiku-4-5"
                                         2000 1000 3000 4000)]
          (assert.is_true (< (math.abs (- estimate 0.0123)) 0.000000001)))))

    (it "includes the best-effort OpenAI nano rate and omits OpenRouter estimates"
      (fn []
        (let [p (pricing.for-model "gpt-5.4-nano")]
          (assert.is_truthy p)
          (assert.are.equal 0.20 p.input-per-million)
          (assert.are.equal 1.25 p.output-per-million))
        ;; OpenRouter pricing follows the underlying model and is deliberately
        ;; documented as an omission rather than guessed from the namespace.
        (assert.is_nil (pricing.for-model "openai/gpt-5.4-nano"))))

    (it "uses the sub-cent marker and omits unknown models"
      (fn []
        (assert.are.equal "<$0.001"
                          (pricing.format-cost "claude-haiku-4-5"
                                               1 0))
        (assert.is_nil (pricing.estimate "claude-future-unknown"
                                         1000 1000 1000 1000))
        (assert.is_nil (pricing.format-cost "claude-future-unknown"
                                            1000 1000 1000 1000))))))
