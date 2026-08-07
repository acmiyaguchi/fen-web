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

;; This harness is deliberately assembled here, rather than in the host
;; responder: it is placed after the document doctype/charset metadata but
;; before the app's first script, so it sees exceptions thrown while the
;; app's own inline scripts are parsed/executed. It never depends on the
;; parent VM; it only posts bounded, stringified records to WebHostPreview.
;; The property accessors keep our console wrappers in place when an app
;; assigns console.log/warn/etc. again or replaces window.console itself.
(local PREVIEW-CONSOLE-HARNESS
  (table.concat
    ["<script>"
     "(function(){"
     "  'use strict';"
     "  window.__fenPreviewConsoleHarness = true;"
     "  var GENERATION = __FEN_PREVIEW_GENERATION__;"
     "  var MAX_TEXT = 800, MAX_ARGS = 20;"
     "  function cut(value, limit){ value = String(value); return value.length > limit ? value.slice(0, limit - 1) + '…' : value; }"
     "  function stackOf(value){ try { return value && typeof value.stack === 'string' ? cut(value.stack, MAX_TEXT * 4) : ''; } catch (_) { return ''; } }"
     "  function stringify(value, depth, seen){"
     "    if (value === undefined) return 'undefined';"
     "    if (value === null) return 'null';"
     "    if (typeof value === 'string') return cut(value, MAX_TEXT);"
     "    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return cut(String(value), MAX_TEXT);"
     "    if (typeof value === 'function') return '[Function]';"
     "    if (typeof value === 'symbol') return cut(String(value), MAX_TEXT);"
     "    try {"
     "      if (value && value.nodeType) return '[Node ' + cut(value.nodeName || 'node', 80) + ']';"
     "      var errorStack = stackOf(value);"
     "      if (errorStack) return errorStack;"
     "      if (!value || typeof value !== 'object') return cut(String(value), MAX_TEXT);"
     "      if (depth > 2) return '[Object]';"
     "      if (seen.indexOf(value) >= 0) return '[Circular]';"
     "      seen.push(value);"
     "      try {"
     "        if (Array.isArray(value)) {"
     "          var array = [], arrayLength = Math.min(value.length >>> 0, 10);"
     "          for (var i = 0; i < arrayLength; i += 1) array.push(stringify(value[i], depth + 1, seen));"
     "          return cut('[' + array.join(', ') + ']', MAX_TEXT);"
     "        }"
     "        var keys = Object.keys(value).slice(0, 10), parts = [];"
     "        for (var k = 0; k < keys.length; k += 1) {"
     "          var key = keys[k], item;"
     "          try { item = value[key]; } catch (_) { item = '[Unreadable]'; }"
     "          parts.push(key + ': ' + stringify(item, depth + 1, seen));"
     "        }"
     "        return cut('{' + parts.join(', ') + '}', MAX_TEXT);"
     "      } finally { seen.pop(); }"
     "    } catch (_) { try { return cut(String(value), MAX_TEXT); } catch (__) { return '[Unprintable]'; } }"
     "  }"
     "  function argsOf(args){ var out = [], length = Math.min(args.length >>> 0, MAX_ARGS); for (var i = 0; i < length; i += 1) out.push(stringify(args[i], 0, [])); return out; }"
     "  function send(level, args, options){"
     "    var entry = { level: level, args: argsOf(args), generation: GENERATION }, stack = options && options.stack;"
     "    if (!stack && level === 'error') for (var i = 0; i < args.length; i += 1) { stack = stackOf(args[i]); if (stack) break; }"
     "    if (stack) entry.stack = cut(stack, MAX_TEXT * 4);"
     "    if (options && options.uncaught) entry.uncaught = true;"
     "    try { window.parent.postMessage({ __fenPreview: true, type: 'console', entry: entry }, '*'); } catch (_) {}"
     "  }"
     "  var consoleObject = window.console || {}, levels = ['log', 'warn', 'error', 'info', 'debug'];"
     "  try { Object.defineProperty(window, 'console', { configurable: false, enumerable: true, get: function(){ return consoleObject; }, set: function(_value){ } }); } catch (_) { try { window.console = consoleObject; } catch (__) {} }"
     "  levels.forEach(function(level){"
     "    var original, replacement, sending = false;"
     "    try { original = typeof consoleObject[level] === 'function' ? consoleObject[level] : function(){}; } catch (_) { original = function(){}; }"
     "    replacement = original;"
     "    var wrapped = function(){"
     "      if (sending) return original.apply(consoleObject, arguments);"
     "      sending = true;"
     "      try { send(level, arguments); return replacement.apply(consoleObject, arguments); }"
     "      finally { sending = false; }"
     "    };"
     "    try { Object.defineProperty(consoleObject, level, { configurable: false, enumerable: true, get: function(){ return wrapped; }, set: function(value){ if (value === wrapped) return; replacement = typeof value === 'function' ? value : function(){}; } }); } catch (_) { try { consoleObject[level] = wrapped; } catch (__) {} }"
     "  });"
     "  var trueOnError = null;"
     "  try { trueOnError = typeof window.onerror === 'function' ? window.onerror : null; } catch (_) { trueOnError = null; }"
     "  var replacementOnError = trueOnError, sendingOnError = false;"
     "  var onError = function(message, source, line, column, error){"
     "    if (sendingOnError) return trueOnError ? trueOnError.apply(this, arguments) : false;"
     "    var location = source ? String(source) + ':' + String(line || 0) + ':' + String(column || 0) : '';"
     "    sendingOnError = true;"
     "    try {"
     "      send('error', location ? [message, location] : [message], { uncaught: true, stack: stackOf(error) });"
     "      if (replacementOnError) return replacementOnError.apply(this, arguments);"
     "      return false;"
     "    } finally { sendingOnError = false; }"
     "  };"
     "  try { Object.defineProperty(window, 'onerror', { configurable: true, get: function(){ return onError; }, set: function(value){ if (value === onError) return; replacementOnError = typeof value === 'function' ? value : null; } }); } catch (_) { window.onerror = onError; }"
     "  window.addEventListener('unhandledrejection', function(event){ var reason = event && event.reason; send('error', [reason], { uncaught: true, stack: stackOf(reason) }); });"
     "})();"
     "</script>"] "\n"))

(fn with-console-harness [page]
  ;; Keep a valid user doctype first. Within the document prologue, put the
  ;; harness after a charset declaration when one exists, but never after the
  ;; first app script (which is the earliest code the harness must observe).
  (var insert-at 1)
  (let [doctype (string.match page "^%s*<![Dd][Oo][Cc][Tt][Yy][Pp][Ee][^>]*>")]
    (when doctype
      (set insert-at (+ (length doctype) 1))))
  (let [first-script (or (pick-values 1
                             (string.find page "<[Ss][Cc][Rr][Ii][Pp][Tt][^>]*>" insert-at))
                         (+ (length page) 1))
        (meta-start meta-end) (string.find page
                                         "<[Mm][Ee][Tt][Aa][^>]-[Cc][Hh][Aa][Rr][Ss][Ee][Tt][^>]*>"
                                         insert-at)]
    (when (and meta-end (< meta-start first-script))
      (set insert-at (+ meta-end 1))))
  (.. (string.sub page 1 (- insert-at 1))
      PREVIEW-CONSOLE-HARNESS
      (string.sub page insert-at)))

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

;; @doc fen_web.web.preview.html.inline-styles
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

;; @doc fen_web.web.preview.html.inline-scripts
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
      "preview_refresh.</p></body></html>"))

;; @doc fen_web.web.preview.html.build-page
;; kind: function
;; signature: (build-page kv entry-path) -> html, entry-found?
;; summary: Assemble a self-contained preview document from the vfs entry file (default /index.html) with same-tree stylesheet/script references inlined; returns a friendly fallback page (and false) when the entry does not exist.
;; tags: preview html build vfs
(fn M.build-page [kv entry-path]
  (let [entry (if (or (not entry-path) (= entry-path "")) "/index.html" entry-path)
        (content _err) (vfs.read-file kv entry)]
    (if (not content)
        (values (with-console-harness (fallback-page entry)) false)
        (let [base (dirname entry)
              styled (M.inline-styles kv base content)
              inlined (M.inline-scripts kv base styled)]
          (values (with-console-harness inlined) true)))))

M
