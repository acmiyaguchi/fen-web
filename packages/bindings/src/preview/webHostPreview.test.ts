import { test } from "node:test";
import assert from "node:assert/strict";

import { WebHostPreview } from "./webHostPreview.js";
import { wrapSrcdoc, PREVIEW_RESPONDER_SOURCE } from "./responder.js";
import { FakePreview } from "./fakePreview.js";

// A hand-rolled fake document/window/iframe (no jsdom in this repo). It records
// the iframe attributes set, exposes the registered message listener so a test
// can dispatch synthetic messages, and lets a test choose each message's
// `source` to exercise the security guard.
function makeFakeDom() {
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  };
  const attrs: Record<string, string> = {};
  let loadListener: (() => void) | undefined;
  let removed = false;
  const iframe = {
    contentWindow,
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
    addEventListener(_type: "load", listener: () => void) {
      loadListener = listener;
    },
    remove() {
      removed = true;
    },
  };
  const appended: unknown[] = [];
  const mount = { appendChild: (node: unknown) => void appended.push(node) };
  const document = {
    createElement: (_tag: "iframe") => iframe,
    getElementById: (_id: string) => mount,
    body: mount,
  };
  let messageListener:
    | ((ev: { data: unknown; source: unknown; origin?: string }) => void)
    | undefined;
  const window = {
    addEventListener(
      _type: "message",
      listener: (ev: { data: unknown; source: unknown; origin?: string }) => void,
    ) {
      messageListener = listener;
    },
    removeEventListener(
      _type: "message",
      listener: (ev: { data: unknown; source: unknown; origin?: string }) => void,
    ) {
      if (messageListener === listener) messageListener = undefined;
    },
  };
  return {
    document,
    window,
    iframe,
    contentWindow,
    attrs,
    posted,
    appended,
    get removed() {
      return removed;
    },
    fireLoad: () => loadListener?.(),
    dispatchMessage: (ev: { data: unknown; source: unknown; origin?: string }) =>
      messageListener?.(ev),
  };
}

test("setHtml creates an allow-scripts iframe with NO allow-same-origin", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<h1>hi</h1>");

  assert.equal(dom.attrs.sandbox, "allow-scripts", "sandbox must be exactly allow-scripts");
  assert.ok(
    !dom.attrs.sandbox.includes("allow-same-origin"),
    "SECURITY: allow-same-origin must never be granted",
  );
  assert.ok(dom.attrs.srcdoc.includes("<h1>hi</h1>"), "srcdoc should carry the rendered page");
  assert.ok(
    dom.attrs.srcdoc.includes("__fenPreview"),
    "srcdoc should inject the RPC responder",
  );
});

test("wrapSrcdoc appends the responder after the page body", () => {
  const doc = wrapSrcdoc("<body>app</body>");
  assert.ok(doc.startsWith("<body>app</body>"), "page HTML comes first");
  assert.ok(doc.includes(PREVIEW_RESPONDER_SOURCE), "responder source is injected");
});

test("an RPC completes when the matching iframe window replies", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<div></div>");
  dom.fireLoad(); // responder ready

  const id = preview.rpcStart({ method: "query", selector: "#x" });
  assert.equal(dom.posted.length, 1, "request should be posted into the iframe once ready");
  assert.equal(preview.rpcPoll(id).done, false, "not done before a reply");

  dom.dispatchMessage({
    data: { __fenPreview: true, id, result: { ok: true, value: { count: 1 } } },
    source: dom.contentWindow,
    origin: "null",
  });

  const poll = preview.rpcPoll(id);
  assert.equal(poll.done, true, "done after the iframe replies");
  assert.deepEqual(poll.result, { ok: true, value: { count: 1 } });
});

test("SECURITY: a reply from a foreign window source is ignored", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<div></div>");
  dom.fireLoad();

  const id = preview.rpcStart({ method: "eval", expr: "1+1" });
  // A message that spoofs the payload but comes from some OTHER window.
  const attacker = { postMessage() {} };
  dom.dispatchMessage({
    data: { __fenPreview: true, id, result: { ok: true, value: 2 } },
    source: attacker,
    origin: "https://evil.example",
  });

  assert.equal(
    preview.rpcPoll(id).done,
    false,
    "a reply not from the iframe's own window must be rejected",
  );
});

test("RPCs started before ready are buffered, then flushed on load", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<div></div>");

  const id = preview.rpcStart({ method: "click", selector: "#go" });
  assert.equal(dom.posted.length, 0, "nothing posted before the iframe is ready");

  dom.fireLoad();
  assert.equal(dom.posted.length, 1, "buffered request flushes once ready");
  const msg = dom.posted[0].message as { id: number; method: string; selector: string };
  assert.equal(msg.id, id);
  assert.equal(msg.method, "click");
  assert.equal(msg.selector, "#go");
});

test("dispose removes the iframe/listener and permits a clean fresh iframe", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<div>old</div>");
  const pending = preview.rpcStart({ method: "query", selector: "#old" });

  preview.dispose();
  assert.equal(dom.removed, true, "dispose should remove the old iframe");
  assert.throws(() => preview.rpcPoll(pending), /unknown rpc id/);

  preview.setHtml("<div>new</div>");
  assert.equal(dom.appended.length, 2, "a fresh boot should append one replacement iframe");
});

test("FakePreview records HTML + requests and resolves synchronously", () => {
  const fake = new FakePreview((req) =>
    req.method === "eval" ? { ok: true, value: 42 } : { ok: true },
  );
  fake.setHtml("<p>page</p>");
  assert.equal(fake.html, "<p>page</p>");

  const id = fake.rpcStart({ method: "eval", expr: "6*7" });
  const poll = fake.rpcPoll(id);
  assert.equal(poll.done, true);
  assert.deepEqual(poll.result, { ok: true, value: 42 });
  assert.equal(fake.requests[0].expr, "6*7");
});
