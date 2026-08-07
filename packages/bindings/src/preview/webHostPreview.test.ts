import { test } from "node:test";
import assert from "node:assert/strict";

import { WebHostPreview } from "./webHostPreview.js";
import { wrapSrcdoc, PREVIEW_RESPONDER_SOURCE } from "./responder.js";
import { FakePreview } from "./fakePreview.js";
import {
  PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT,
  serializePreviewConsoleEntries,
} from "./console.js";

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
  preview.setHtml("<h1>hi</h1><script>var GENERATION = __FEN_PREVIEW_GENERATION__;</script>");

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
  assert.ok(dom.attrs.srcdoc.includes("var GENERATION = 1;"));
  preview.setHtml("<h1>fresh</h1><script>var GENERATION = __FEN_PREVIEW_GENERATION__;</script>");
  assert.ok(dom.attrs.srcdoc.includes("var GENERATION = 2;"));
});

test("wrapSrcdoc appends the responder after the page body", () => {
  const doc = wrapSrcdoc("<body>app __FEN_PREVIEW_GENERATION__</body>", 7);
  assert.ok(doc.startsWith("<body>app 7</body>"), "page HTML comes first");
  assert.ok(doc.includes(PREVIEW_RESPONDER_SOURCE), "responder source is injected");
});

test("console messages are source-validated, bounded, and drain since the last check", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({
    document: dom.document,
    window: dom.window,
    consoleLimit: 2,
  });
  preview.setHtml("<div></div>");

  dom.dispatchMessage({
    data: { __fenPreview: true, type: "console", entry: { level: "log", args: ["one"] } },
    source: { foreign: true },
  });
  assert.deepEqual(preview.drainConsole(), [], "foreign console messages must be ignored");

  dom.dispatchMessage({
    data: { __fenPreview: true, type: "console", entry: { level: "log", args: ["one"], generation: 1 } },
    source: dom.contentWindow,
  });
  dom.dispatchMessage({
    data: {
      __fenPreview: true,
      type: "console",
      entry: {
        level: "error",
        args: ["boom"],
        stack: "Error: boom\\n at app.js:1",
        uncaught: true,
        generation: 1,
      },
    },
    source: dom.contentWindow,
  });
  dom.dispatchMessage({
    data: { __fenPreview: true, type: "console", entry: { level: "warn", args: ["old"], generation: 1 } },
    source: dom.contentWindow,
  });
  assert.equal(preview.uncaughtConsoleErrors(), 1);
  assert.deepEqual(preview.drainConsole(), [
    { level: "error", args: ["boom"], stack: "Error: boom\\n at app.js:1", uncaught: true },
    { level: "warn", args: ["old"] },
  ], "the bounded ring keeps the newest entries");
  assert.equal(preview.uncaughtConsoleErrors(), 0);
  assert.deepEqual(preview.drainConsole(), []);

  dom.dispatchMessage({
    data: { __fenPreview: true, type: "console", entry: { level: "error", args: ["after"], generation: 1 } },
    source: dom.contentWindow,
  });
  preview.setHtml("<div>new document</div>");
  dom.dispatchMessage({
    data: {
      __fenPreview: true,
      type: "console",
      entry: { level: "error", args: ["stale"], generation: 1 },
    },
    source: dom.contentWindow,
  });
  dom.dispatchMessage({
    data: {
      __fenPreview: true,
      type: "console",
      entry: { level: "log", args: ["fresh"], generation: 2 },
    },
    source: dom.contentWindow,
  });
  assert.deepEqual(preview.drainConsole(), [{ level: "log", args: ["fresh"] }]);

  dom.dispatchMessage({
    data: {
      __fenPreview: true,
      id: 999,
      result: { ok: true, value: "rpc" },
      console: 1,
    },
    source: dom.contentWindow,
  });
  // A legacy-looking `console` field must not swallow a normal RPC reply.
  const rpcId = preview.rpcStart({ method: "eval", expr: "1+1" });
  dom.dispatchMessage({
    data: {
      __fenPreview: true,
      id: rpcId,
      result: { ok: true, value: "not swallowed" },
      console: 1,
    },
    source: dom.contentWindow,
  });
  assert.deepEqual(preview.rpcPoll(rpcId), {
    done: true,
    result: { ok: true, value: "not swallowed" },
  });
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
  assert.deepEqual(poll.result, { ok: true, value: '{"count":1}' });
});

test("DOM and interaction RPCs relay their bounded command fields", () => {
  const dom = makeFakeDom();
  const preview = new WebHostPreview({ document: dom.document, window: dom.window });
  preview.setHtml("<main></main>");
  dom.fireLoad();

  const domId = preview.rpcStart({
    method: "dom",
    selector: "#app",
    maxDepth: 2,
    maxSize: 512,
  });
  const interactId = preview.rpcStart({
    method: "interact",
    action: "type",
    selector: "#name",
    text: "Ada",
  });
  assert.equal(dom.posted.length, 2);
  assert.deepEqual(dom.posted[0].message, {
    __fenPreview: true,
    id: domId,
    method: "dom",
    selector: "#app",
    value: undefined,
    action: undefined,
    text: undefined,
    maxDepth: 2,
    maxSize: 512,
    expr: undefined,
  });
  assert.deepEqual(dom.posted[1].message, {
    __fenPreview: true,
    id: interactId,
    method: "interact",
    selector: "#name",
    value: undefined,
    action: "type",
    text: "Ada",
    maxDepth: undefined,
    maxSize: undefined,
    expr: undefined,
  });

  dom.dispatchMessage({
    data: { __fenPreview: true, id: domId, result: { ok: true, value: "<main>...</main>" } },
    source: dom.contentWindow,
  });
  assert.deepEqual(preview.rpcPoll(domId), {
    done: true,
    result: { ok: true, value: "<main>...</main>" },
  });
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

test("unknown console levels normalize to log", () => {
  const fake = new FakePreview();
  fake.recordConsole({ level: "fatal", args: ["odd level"] });
  assert.deepEqual(fake.drainConsole(), [{ level: "log", args: ["odd level"] }]);
});

test("preview-console aggregate is capped and reports omitted older entries", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({
    level: "error",
    args: Array.from({ length: 20 }, () => `${String(i).padStart(3, "0")}-${"x".repeat(796)}`),
    stack: "Error: " + "s".repeat(3190),
  }));
  const text = serializePreviewConsoleEntries(entries);
  assert.ok(text.length <= PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT);
  const parsed = JSON.parse(text) as Array<{ args: string[] }>;
  assert.ok(parsed.length < entries.length, "the aggregate should omit older entries");
  // The buggy first-fit-from-newest loop kept exactly 1 entry + marker.
  // Correct packing at ~19KB/entry keeps several and uses most of the
  // budget — assert both, without over-fitting an exact count.
  assert.ok(
    parsed.length > 2,
    `entries that fit must be retained, not discarded (kept ${parsed.length})`,
  );
  assert.ok(
    text.length > PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT / 2,
    `the cap budget should be mostly used, not abandoned (used ${text.length})`,
  );
  assert.match(parsed.at(-1)?.args[0] ?? "", /omitted/);
  assert.match(JSON.stringify(parsed), /199-/i, "newest entries should win");
});

test("small drains round-trip every entry with no omission marker", () => {
  const entries = [
    { level: "log", args: ["one"] },
    { level: "warn", args: ["two"] },
    { level: "error", args: ["three"] },
  ];
  const text = serializePreviewConsoleEntries(entries);
  const parsed = JSON.parse(text) as Array<{ args: string[] }>;
  assert.equal(parsed.length, 3, "everything fits, everything stays");
  assert.ok(!text.includes("omitted"), "no false cap marker on a tiny payload");
});

test("FakePreview has the same console drain and uncaught-error surface", () => {
  const fake = new FakePreview(() => ({ ok: true }), { consoleLimit: 2 });
  fake.setHtml("<p>page</p>");
  fake.recordConsole({ level: "info", args: ["hello"] });
  fake.recordConsole({ level: "error", args: ["bad"], stack: "Error: bad", uncaught: true });
  assert.equal(fake.uncaughtConsoleErrors(), 1);
  assert.deepEqual(fake.drainConsole(), [
    { level: "info", args: ["hello"] },
    { level: "error", args: ["bad"], stack: "Error: bad", uncaught: true },
  ]);
  assert.equal(fake.uncaughtConsoleErrors(), 0);
  fake.recordConsole({ level: "log", args: ["stale"] });
  fake.setHtml("<p>fresh</p>");
  assert.deepEqual(fake.drainConsole(), []);
});

test("FakePreview records HTML + requests and pre-serializes RPC values", () => {
  const fake = new FakePreview((req) =>
    req.method === "eval" ? { ok: true, value: { answer: 42 } } : { ok: true },
  );
  fake.setHtml("<p>page</p>");
  assert.equal(fake.html, "<p>page</p>");

  const id = fake.rpcStart({ method: "eval", expr: "6*7" });
  const poll = fake.rpcPoll(id);
  assert.equal(poll.done, true);
  assert.deepEqual(poll.result, { ok: true, value: '{"answer":42}' });
  assert.equal(fake.requests[0].expr, "6*7");
});
