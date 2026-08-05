;; Preview page assembler (fen-web#8): render the IndexedDB virtual-FS tree
;; into a single self-contained HTML document for the sandboxed preview
;; iframe. This is application policy (which files, how to inline them), so it
;; lives in Fennel — the TS host.preview primitive only sets the iframe srcdoc
;; and runs the RPC (docs/architecture/fennel-first.md).
;;
;; The iframe has NO allow-same-origin and no network reach, so it cannot
;; resolve relative <link>/<script src> URLs itself. build-page therefore
;; inlines same-tree stylesheet and script references from the vfs, producing
;; one document that runs standalone. Absolute URLs (http(s)://, //) are left
;; untouched — they either work as remote resources or simply don't load; we
;; never fetch them here.
;;
;; Security: build-page reads ONLY the vfs (fen_web.tools.vfs, "fs:"-prefixed
;; host.kv keys). The API key lives under env/apikey/<VAR> (a different key
;; space) and is never walked or emitted here — see the preview_test no-leak
;; spec.

(local vfs (require :fen_web.tools.vfs))

(local M {})

(fn dirname [path]
  (let [d (string.match path "^(.*)/[^/]+$")]
    (or d "")))

(fn absolute-url? [href]
  ;; scheme://… or protocol-relative //…, or a data: URI — anything we must
  ;; not treat as a vfs-relative path.
  (or (string.match href "^%a[%w+.%-]*:")
      (= (string.sub href 1 2) "//")))

(fn resolve-ref [kv base-dir href]
  "Read a vfs-relative asset referenced from a page in base-dir, or nil for
   absolute URLs / missing files."
  (if (or (not href) (= href "") (absolute-url? href))
      nil
      (let [path (if (= (string.sub href 1 1) "/")
                     href
                     (if (= base-dir "") (.. "/" href) (.. base-dir "/" href)))
            (content _err) (vfs.read-file kv path)]
        content)))

(fn attr [attrs name]
  (string.match attrs (.. name "%s*=%s*[\"']([^\"']+)[\"']")))

;; @doc fen_web.demo.preview.html.inline-styles
;; kind: function
;; signature: (inline-styles kv base-dir html) -> string
;; summary: Replace <link rel=stylesheet href=REL> tags whose href resolves in the vfs with an inline <style> block; leave absolute or unresolved refs as-is.
;; tags: preview html inline css
(fn M.inline-styles [kv base-dir html]
  (pick-values 1
    (string.gsub html "<link([^>]-)/?>"
      (fn [attrs]
        (let [rel (attr attrs "rel")
              href (attr attrs "href")]
          (if (and href (or (not rel)
                            (string.find (string.lower rel) "stylesheet" 1 true)))
              (let [content (resolve-ref kv base-dir href)]
                (if content (.. "<style>\n" content "\n</style>") nil))
              nil))))))

;; @doc fen_web.demo.preview.html.inline-scripts
;; kind: function
;; signature: (inline-scripts kv base-dir html) -> string
;; summary: Replace external <script src=REL></script> tags whose src resolves in the vfs with an inline <script> block holding the file contents; leave inline scripts and absolute/unresolved refs untouched.
;; tags: preview html inline js
(fn M.inline-scripts [kv base-dir html]
  ;; Only matches empty-body script tags (external references); inline
  ;; <script>code</script> has a non-whitespace body and is left alone.
  (pick-values 1
    (string.gsub html "<script([^>]-)>%s*</script>"
      (fn [attrs]
        (let [src (attr attrs "src")]
          (if src
              (let [content (resolve-ref kv base-dir src)]
                (if content (.. "<script>\n" content "\n</script>") nil))
              nil))))))

;; entry is agent-supplied, so it must be concatenated in (not used as a
;; string.gsub replacement): a path containing '%' would be read as a capture
;; reference and throw "invalid capture index", which — because refresh-tool
;; runs uncaught in cooperative mode — would unwind the whole turn instead of
;; showing the fallback page.
(fn fallback-page [entry]
  (.. "<!doctype html><html><head><meta charset=\"utf-8\">"
      "<title>fen-web preview</title></head><body>"
      "<p style=\"font-family:sans-serif;color:#555\">"
      "No preview entry found. Create " entry " in the workspace, then run "
      "preview.refresh.</p></body></html>"))

;; @doc fen_web.demo.preview.html.build-page
;; kind: function
;; signature: (build-page kv entry-path) -> html, entry-found?
;; summary: Assemble a self-contained preview document from the vfs entry file (default /index.html) with same-tree stylesheet/script references inlined; returns a friendly fallback page (and false) when the entry does not exist.
;; tags: preview html build vfs
(fn M.build-page [kv entry-path]
  (let [entry (if (or (not entry-path) (= entry-path "")) "/index.html" entry-path)
        (content _err) (vfs.read-file kv entry)]
    (if (not content)
        (values (fallback-page entry) false)
        (let [base (dirname entry)
              styled (M.inline-styles kv base content)
              inlined (M.inline-scripts kv base styled)]
          (values inlined true)))))

M
