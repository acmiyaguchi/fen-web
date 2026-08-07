;; Browser-native `edit` tool: same name/schema/result shape and exact-
;; match semantics as fen's builtin edit.fnl (old_string must occur
;; exactly once; multiple edits apply to the original snapshot, not
;; sequentially; files/edits batches are all-or-nothing on validation),
;; ported to read/write through fen_web.tools.vfs instead of io.open.

(local util (require :fen_web.tools.util))
(local vfs (require :fen_web.tools.vfs))
(local path-ops (require :fen_web.tools.path_ops))

(local LINES-BEFORE-YIELD 512)

(fn find-all [s sub ?yield-fn]
  "All 1-based start indices where literal sub occurs in s."
  (let [out []
        sub-len (length sub)]
    (var i 1)
    (var done? false)
    (while (not done?)
      (let [pos (string.find s sub i 1)]
        (if pos
            (do (table.insert out pos)
                (set i (+ pos sub-len))
                (when (and ?yield-fn (= (% (length out) LINES-BEFORE-YIELD) 0))
                  (?yield-fn)))
            (set done? true))))
    out))

(fn has-crlf? [s]
  (not= nil (string.find s "\r\n" 1 true)))

(fn validate-edits [content edits ?yield-fn]
  "Locate every edit's match. Each old_string must occur exactly once."
  (let [matches []
        crlf? (has-crlf? content)]
    (var error-msg nil)
    (each [i edit (ipairs edits)]
      (when (not error-msg)
        (let [old-str edit.old_string]
          (if (or (not old-str) (= old-str ""))
              (set error-msg (.. "edit " (tostring i) ": missing old_string"))
              (let [hits (find-all content old-str ?yield-fn)]
                (util.maybe-yield ?yield-fn)
                (if (= (length hits) 0)
                    (set error-msg
                         (.. "edit " (tostring i) ": old_string not found"
                             (if (and crlf? (not (has-crlf? old-str)))
                                 " (file has CRLF line endings; old_string uses LF — try \\r\\n)"
                                 "")))
                    (> (length hits) 1)
                    (set error-msg (.. "edit " (tostring i)
                                       ": old_string is not unique ("
                                       (tostring (length hits))
                                       " matches)"))
                    (table.insert matches
                      {:start (. hits 1)
                       :end (+ (. hits 1) (length old-str) -1)
                       :new (or edit.new_string "")
                       :index i})))))))
    (when (not error-msg)
      (table.sort matches (fn [a b] (< a.start b.start)))
      (each [k cur (ipairs matches)]
        (when (and (not error-msg) (> k 1))
          (let [prev (. matches (- k 1))]
            (when (>= prev.end cur.start)
              (set error-msg (.. "edits " (tostring prev.index)
                                 " and " (tostring cur.index)
                                 " overlap")))))))
    (if error-msg (values nil error-msg) (values matches nil))))

(fn apply-edits [content matches]
  "Splice each match's replacement in from end to start."
  (var result content)
  (for [k (length matches) 1 -1]
    (let [m (. matches k)]
      (set result
           (.. (string.sub result 1 (- m.start 1))
               m.new
               (string.sub result (+ m.end 1))))))
  result)

(fn validate-edit-file [path edits ctx ?yield-fn]
  (if (or (not path) (= path ""))
      (values nil "missing 'path'")
      (or (not edits) (= (length edits) 0))
      (values nil "missing 'edits'")
      (let [(resolved perr) (path-ops.resolve-path path ctx)]
        (if perr
            (values nil perr)
            (let [(content rerr) (vfs.read-file (util.get-kv) resolved)]
              (if rerr
                  (values nil rerr)
                  (do
                    (util.maybe-yield ?yield-fn)
                    (let [(matches verr) (validate-edits content edits ?yield-fn)]
                      (if verr
                          (values nil verr)
                          (values {:path resolved
                                   :edits edits
                                   :content content
                                   :matches matches}
                                  nil))))))))))

(fn write-edit-file [validated ?yield-fn]
  (util.maybe-yield ?yield-fn)
  (let [result (apply-edits validated.content validated.matches)
        (ok? werr) (vfs.write-file (util.get-kv) validated.path result)]
    (util.maybe-yield ?yield-fn)
    (if (not ok?) (values nil werr) (values true nil))))

(fn run-edit-one [{: path : edits} ctx ?yield-fn]
  (let [(validated verr) (validate-edit-file path edits ctx ?yield-fn)]
    (if verr
        (util.err verr)
        (let [(_ werr) (write-edit-file validated ?yield-fn)]
          (if werr
              (util.err werr)
              (util.ok (.. "applied " (tostring (length edits))
                           " edit(s) to " path)))))))

(fn run-edit-batch [files ctx ?yield-fn]
  (if (or (not files) (= (length files) 0))
      (util.err "missing 'files'")
      (let [validated []
            seen {}]
        (var error-msg nil)
        (each [i f (ipairs files)]
          (when (not error-msg)
            (let [path (?. f :path)
                  ;; Key the duplicate check on the normalized path, not
                  ;; the raw string: "/a.txt" and "a.txt" name the same
                  ;; vfs file, and letting both through would validate
                  ;; both against the same original snapshot and then
                  ;; have the second write silently clobber the first.
                  (norm _nerr) (if path (path-ops.resolve-path path ctx) (values nil nil))]
              (if (and norm (. seen norm))
                  (set error-msg (.. path ": duplicate path in files batch; combine edits for the same file in one entry"))
                  (do
                    (when norm (tset seen norm true))
                    (let [(v verr) (validate-edit-file path (?. f :edits) ctx ?yield-fn)]
                      (if verr
                          (set error-msg (.. (or path (.. "file " (tostring i))) ": " verr))
                          (table.insert validated v)))))))
          (util.maybe-yield ?yield-fn))
        (if error-msg
            (util.err error-msg)
            (let [summaries []]
              (var write-err nil)
              (each [_ v (ipairs validated)]
                (when (not write-err)
                  (let [(_ werr) (write-edit-file v ?yield-fn)]
                    (if werr
                        (set write-err (.. v.path ": " werr))
                        (table.insert summaries
                                      (.. "applied " (tostring (length v.edits))
                                          " edit(s) to " v.path))))))
              (if write-err
                  (util.err write-err)
                  (util.ok (table.concat summaries "\n"))))))))

(fn run-edit [args ctx ?yield-fn]
  (let [has-single? (or (and args.path (not= args.path ""))
                         (not= args.edits nil))
        has-files? (not= args.files nil)]
    (if (and has-single? has-files?)
        (util.err "provide either 'path'/'edits' or 'files', not both")
        has-files?
        (run-edit-batch args.files ctx ?yield-fn)
        (run-edit-one args ctx ?yield-fn))))

{:name :edit
 :label "Edit"
 :snippet "Make exact-text replacements in one or more files"
 :description "Make exact-text replacements. Batch all known non-overlapping edits into one call: use one `edits` array for multiple changes in the same file, and use `files` for changes across multiple files. Do not emit separate edit calls for independent changes unless a later edit depends on seeing an earlier result. Single-file shape: {path, edits}. Batch shape: {files:[{path, edits}, ...]}, e.g. {files:[{path:\"a.fnl\", edits:[...]}, {path:\"b.fnl\", edits:[...]}]}. Each old_string must match uniquely in the original; multiple disjoint edits per file are applied to the original snapshot, not sequentially. Batch validation is all-or-nothing: if any file fails validation, no file is mutated. After validation succeeds, files are written sequentially; a rare write failure can leave earlier files already written."
 :parameters {:type :object
              :properties {:path {:type :string
                                  :description "File path for single-file edits; mutually exclusive with files"}
                           :edits {:type :array
                                   :description "Replacements to apply to path. Put all known non-overlapping edits for this file in this one array."
                                   :items {:type :object
                                           :properties {:old_string {:type :string
                                                                     :description "Exact text to match (unique in file)"}
                                                        :new_string {:type :string
                                                                     :description "Replacement text"}}
                                           :required [:old_string :new_string]}}
                           :files {:type :array
                                   :description "Preferred for multi-file edits. Batch edits across files in one call; mutually exclusive with path/edits."
                                   :items {:type :object
                                           :properties {:path {:type :string
                                                               :description "File path"}
                                                        :edits {:type :array
                                                                :description "Replacements to apply"
                                                                :items {:type :object
                                                                        :properties {:old_string {:type :string
                                                                                                  :description "Exact text to match (unique in file)"}
                                                                                     :new_string {:type :string
                                                                                                  :description "Replacement text"}}
                                                                        :required [:old_string :new_string]}}}
                                           :required [:path :edits]}}}}
 :execute run-edit}
