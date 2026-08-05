// The RPC responder that runs INSIDE the sandboxed preview iframe (a foreign
// execution context — hence TS, per docs/architecture/fennel-first.md's
// litmus test). It is injected into every rendered preview document by
// wrapSrcdoc; the parent (WebHostPreview) posts RPC requests to the iframe's
// window and this script answers them. It runs in an opaque origin with no
// allow-same-origin, so it cannot reach the parent's DOM/FS/key — it can only
// touch its own document and reply through postMessage.
//
// The message shape is symmetric with WebHostPreview: requests and replies
// both carry `__fenPreview: true` and a numeric `id`. Replies are posted back
// to the request's own source/origin, never broadcast to arbitrary windows.

/** Source of the responder, embedded verbatim in the iframe document. Kept as
 * a string (not a real module) because it executes in the iframe, not here. */
export const PREVIEW_RESPONDER_SOURCE = String.raw`
(function () {
  "use strict";
  function serialize(v) {
    if (v === undefined) return null;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  function handle(data) {
    var method = data.method;
    if (method === "query") {
      var els = document.querySelectorAll(data.selector);
      var first = els[0] || null;
      return { ok: true, value: {
        count: els.length,
        found: !!first,
        html: first ? first.outerHTML : null,
        text: first ? (first.textContent || "") : null,
        value: first && ("value" in first) ? first.value : null
      } };
    }
    if (method === "click") {
      var c = document.querySelector(data.selector);
      if (!c) return { ok: false, error: "no element matches " + data.selector };
      c.click();
      return { ok: true, value: { clicked: true } };
    }
    if (method === "fill") {
      var f = document.querySelector(data.selector);
      if (!f) return { ok: false, error: "no element matches " + data.selector };
      f.value = data.value;
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: { filled: true } };
    }
    if (method === "eval") {
      var out = (0, eval)(data.expr);
      return { ok: true, value: serialize(out) };
    }
    if (method === "screenshot") {
      var canvas = data.selector ? document.querySelector(data.selector)
                                 : document.querySelector("canvas");
      if (!canvas || typeof canvas.toDataURL !== "function") {
        return { ok: false, error: "no canvas element to screenshot" };
      }
      return { ok: true, value: { dataUrl: canvas.toDataURL() } };
    }
    return { ok: false, error: "unknown preview method: " + String(method) };
  }
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.__fenPreview !== true || typeof data.id !== "number") return;
    var reply = { __fenPreview: true, id: data.id };
    try {
      reply.result = handle(data);
    } catch (err) {
      reply.result = { ok: false, error: String((err && err.message) || err) };
    }
    var target = ev.source || parent;
    var origin = ev.origin && ev.origin !== "null" ? ev.origin : "*";
    if (target) target.postMessage(reply, origin);
  });
  // Handshake: tell the parent the responder is live so buffered RPCs flush.
  try { parent.postMessage({ __fenPreview: true, ready: true }, "*"); } catch (e) {}
})();
`;

/** Wrap a caller-built preview page (assembled from the virtual FS in Fennel)
 * with the responder script, producing the iframe `srcdoc`. The responder is
 * appended last so it installs after the app's own scripts have defined the
 * globals `preview.eval` may reference. */
export function wrapSrcdoc(html: string): string {
  return `${html}\n<script>${PREVIEW_RESPONDER_SOURCE}</script>`;
}
