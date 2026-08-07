;; Private construction helpers for fen_web.tools.fennel_eval.
;;
;; This is a separate module so the registered tool spec does not grow test
;; or implementation fields that are visible to the extension registry.

(local cjson (require :cjson))
(local path-ops (require :fen_web.tools.path_ops))
(local vfs (require :fen_web.tools.vfs))

(fn copy-table [source]
  (let [out {}]
    (each [k v (pairs source)]
      (tset out k v))
    out))

(fn value-or-error [value error-message]
  (if error-message
      (error error-message)
      value))

(fn ensure-kv [kv]
  (if kv
      kv
      (error "fen_web.tools.fennel_eval: host.kv is not installed")))

(fn resolve-path [path ctx]
  (let [(normalized error-message)
        (path-ops.normalize-in-workspace path ctx)]
    (value-or-error normalized error-message)))

(fn as-json-array [items]
  ;; cjson cannot infer that an empty Lua table is an array. The VFS returns
  ;; list-shaped values, so preserve that shape explicitly at the JSON seam.
  (setmetatable items cjson.array_mt)
  items)

(fn vfs-facade [kv ?ctx ?yield-fn]
  ;; Keep the underlying vfs module and raw host.kv out of the eval env.
  ;; These wrappers turn the module's two-return-value error convention into
  ;; ordinary Lua errors, which makes batch expressions concise and keeps a
  ;; failed file operation inside the tool's pcall boundary. Every path goes
  ;; through path_ops so cwd and workspace-root apply consistently.
  {:normalize (fn [path]
                (resolve-path path ?ctx))
   :read-file (fn [path]
                (let [(content error-message)
                      (vfs.read-file (ensure-kv kv) (resolve-path path ?ctx))]
                  (value-or-error content error-message)))
   :write-file (fn [path content]
                 (let [(ok? error-message)
                       (vfs.write-file (ensure-kv kv)
                                       (resolve-path path ?ctx)
                                       content)]
                   (value-or-error ok? error-message)))
   :delete (fn [path]
             (let [(ok? error-message)
                   (vfs.delete (ensure-kv kv) (resolve-path path ?ctx))]
               (value-or-error ok? error-message)))
   :exists? (fn [path]
              (vfs.exists? (ensure-kv kv) (resolve-path path ?ctx)))
   :list-dir (fn [path]
               (let [(listing error-message)
                     (vfs.list-dir (ensure-kv kv)
                                   (resolve-path path ?ctx)
                                   ?yield-fn)
                     listing (value-or-error listing error-message)]
                 {:dirs (as-json-array listing.dirs)
                  :files (as-json-array listing.files)}))
   :walk (fn [path]
           (let [(files error-message)
                 (vfs.walk (ensure-kv kv)
                           (resolve-path path ?ctx)
                           ?yield-fn)]
             (as-json-array (value-or-error files error-message))))})

;; @doc fen_web.tools.fennel_eval_helpers.scratch-env
;; kind: function
;; signature: (scratch-env kv ?ctx ?yield-fn) -> table
;; summary: Build a fresh Fennel evaluation environment with copied standard libraries and an explicit host.vfs facade over the supplied host.kv and tool context.
;; tags: tools fennel eval scratch vfs
(fn scratch-env [kv ?ctx ?yield-fn]
  (let [facade (vfs-facade kv ?ctx ?yield-fn)
        env {:assert assert
             :error error
             :ipairs ipairs
             :next next
             :pairs pairs
             :pcall pcall
             :select select
             :tonumber tonumber
             :tostring tostring
             :type type
             :xpcall xpcall
             ;; Deliberately do not expose coroutine: a user-created
             ;; coroutine could consume the cooperative tool yield intended
             ;; for the outer VM pump.
             ;; Copy library tables so an expression cannot replace a helper
             ;; in the VM's shared math/string/table libraries by accident.
             :math (copy-table math)
             :string (copy-table string)
             :table (copy-table table)
             :utf8 (copy-table utf8)
             :vfs facade
             :host {:vfs facade}}]
    env))

{:scratch-env scratch-env
 :vfs-facade vfs-facade}
