// The RPC responder that runs INSIDE the sandboxed preview iframe (a foreign
// execution context — hence TS, per docs/architecture/fennel-first.md's
// litmus test). It is injected into every rendered preview document by
// wrapSrcdoc; the parent (WebHostPreview) posts RPC requests to the iframe's
// window and this script answers them. It runs in an opaque origin with no
// allow-same-origin, so it cannot reach the parent's DOM/FS/key — it can only
// touch its own document and reply through postMessage.
//
// The message shape is symmetric with WebHostPreview: requests and replies
// both carry `__fenPreview: true` and a numeric `id`. The responder handles
// DOM snapshots and click/type/submit actions as well as the legacy verbs.
// Replies are posted back to the request's own source/origin, never broadcast
// to arbitrary windows.

/** Source of the responder, embedded verbatim in the iframe document. Kept as
 * a string (not a real module) because it executes in the iframe, not here. */
export const PREVIEW_RESPONDER_SOURCE = String.raw`
(function () {
  "use strict";
  function serialize(v) {
    if (v === undefined) return null;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  var DEFAULT_DOM_DEPTH = 4;
  var MAX_DOM_DEPTH = 12;
  var DEFAULT_DOM_SIZE = 12000;
  var MAX_DOM_SIZE = 32000;

  function boundedNumber(value, fallback, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(number)));
  }

  function domSnapshot(data) {
    var selector = data.selector || "body";
    var root = document.querySelector(selector);
    if (!root) return { ok: false, error: "no element matches " + selector };
    var depth = boundedNumber(data.maxDepth, DEFAULT_DOM_DEPTH, 0, MAX_DOM_DEPTH);
    var size = boundedNumber(data.maxSize, DEFAULT_DOM_SIZE, 64, MAX_DOM_SIZE);
    var copy = root.cloneNode(true);

    // Trim a detached clone so the app's live DOM is never modified. The
    // result remains outerHTML, which is useful to an agent, while maxDepth
    // prevents a large component tree from consuming the whole context.
    function trim(node, level) {
      if (level >= depth) {
        while (node.firstChild) node.removeChild(node.firstChild);
        node.appendChild(document.createTextNode("..."));
        return;
      }
      var children = node.children ? Array.prototype.slice.call(node.children) : [];
      for (var i = 0; i < children.length; i += 1) trim(children[i], level + 1);
    }
    trim(copy, 0);
    var html = copy.outerHTML || String(copy.textContent || "");
    if (html.length > size) html = html.slice(0, size - 3) + "...";
    return { ok: true, value: html };
  }

  function dispatch(target, name) {
    target.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
  }

  function setFieldValue(field, text) {
    var value = String(text == null ? "" : text);
    // Use the native prototype setter when one exists. This avoids stale
    // value trackers in framework-bound inputs while retaining a plain
    // assignment fallback for test doubles and unusual form controls.
    var proto = Object.getPrototypeOf(field);
    var descriptor = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") descriptor.set.call(field, value);
    else field.value = value;
    dispatch(field, "input");
    dispatch(field, "change");
  }

  function interact(data) {
    var action = data.action;
    var selector = data.selector;
    var target = document.querySelector(selector);
    if (!target) return { ok: false, error: "no element matches " + selector };
    if (action === "click") {
      if (typeof target.click === "function") target.click();
      else dispatch(target, "click");
      return { ok: true, value: { action: "click", selector: selector } };
    }
    if (action === "type") {
      if (!("value" in target)) return { ok: false, error: "element is not a form field: " + selector };
      setFieldValue(target, data.text);
      return { ok: true, value: { action: "type", selector: selector, events: ["input", "change"] } };
    }
    if (action === "submit") {
      var form = String(target.tagName || "").toLowerCase() === "form" ? target : target.form;
      if (!form) return { ok: false, error: "element is not a form or form control: " + selector };
      // Dispatch directly instead of invoking a native navigation. The
      // preview deliberately omits allow-forms, and dispatching the bubbling,
      // cancelable event still reaches the app's framework/form handler while
      // keeping the iframe on the current document.
      dispatch(form, "submit");
      return { ok: true, value: { action: "submit", selector: selector } };
    }
    return { ok: false, error: "unknown interact action: " + String(action) };
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
    if (method === "dom") return domSnapshot(data);
    if (method === "interact") return interact(data);
    if (method === "click") {
      var c = document.querySelector(data.selector);
      if (!c) return { ok: false, error: "no element matches " + data.selector };
      c.click();
      return { ok: true, value: { clicked: true } };
    }
    if (method === "fill") {
      var f = document.querySelector(data.selector);
      if (!f) return { ok: false, error: "no element matches " + data.selector };
      setFieldValue(f, data.value);
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

/** Token replaced in the Fennel console harness by wrapSrcdoc. */
export const PREVIEW_CONSOLE_GENERATION_PLACEHOLDER = "__FEN_PREVIEW_GENERATION__";

/** Wrap a caller-built preview page (assembled from the virtual FS in Fennel)
 * with the responder script, producing the iframe `srcdoc`. The responder is
 * appended last so it installs after the app's own scripts have defined the
 * globals `preview.eval` may reference. */
export function wrapSrcdoc(html: string, generation = 0): string {
  const rendered = html.replaceAll(PREVIEW_CONSOLE_GENERATION_PLACEHOLDER, String(generation));
  return `${rendered}\n<script>${PREVIEW_RESPONDER_SOURCE}</script>`;
}
