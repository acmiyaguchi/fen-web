;; Browser notification tool. Permission is shell-owned: the settings panel
;; may request it from a user gesture, but this tool never prompts. When the
;; browser API is denied or unavailable, the host returns a JSON-text fallback
;; result and this tool adds an in-app transcript notice instead.

(local util (require :fen_web.tools.util))
(local json (require :fen.util.json))
(local events (require :fen.core.extensions.events))

(fn fallback-notice [title body]
  (.. "Browser notification unavailable; in-app notice: " title
      (if (and body (not= body "")) (.. " - " body) "")))

(fn emit-fallback! [title body error]
  (events.emit {:type :info
                :text (.. (fallback-notice title body)
                          (if error (.. " (" error ")") ""))}))

(fn host-result [h title body]
  (if (not (and h (= (type h.notify) :function)))
      {:fallback true :error "permission not granted"}
      (let [(called? raw) (pcall h.notify title body)]
        (if (not called?)
            {:fallback true :error "notification unavailable"}
            (= (type raw) :string)
            (let [(decoded? result) (pcall json.decode raw)]
              (if (and decoded? (= (type result) :table))
                  result
                  {:fallback true :error "notification unavailable"}))
            {:fallback true :error "notification unavailable"}))))

(fn run-notify [args _ctx _yield-fn]
  (let [title (and args.title (tostring args.title))
        body (and args.body (tostring args.body))]
    (if (or (not title) (= title ""))
        (util.err "missing 'title'")
        (let [result (host-result _G.__fen_host title body)
              error (or result.error "permission not granted")]
          (if result.fallback
              (do
                (emit-fallback! title body error)
                (util.err error))
              result.ok
              (util.ok "notification sent")
              (util.err error))))))

{:name :notify
 :label "Notify"
 :snippet "Send a browser notification"
 :description "Send a browser notification when you need the user's attention, for example after a long turn or when input is needed. Permission is requested only from the settings panel; if permission is denied or unavailable, an in-app transcript notice is shown and the tool returns a clean error."
 :parameters {:type :object
              :properties {:title {:type :string
                                    :description "Short notification title"}
                           :body {:type :string
                                  :description "Optional notification body"}}
              :required [:title]}
 :execute run-notify}
