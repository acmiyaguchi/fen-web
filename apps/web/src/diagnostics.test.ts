import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DiagnosticsBuffer,
  FEN_VERSION,
  PREVIEW_DIAGNOSTICS_TAIL_LIMIT,
  formatDiagnostics,
  scrubSecrets,
  summarizePayload,
} from "./diagnostics.js";

test("diagnostics ring is bounded and keeps terse event summaries", () => {
  const diagnostics = new DiagnosticsBuffer({ limit: 3 });
  diagnostics.record("turn", { message: "one" }, 1);
  diagnostics.record("turn", { message: "two" }, 2);
  diagnostics.record("turn", { message: "three" }, 3);
  diagnostics.record("turn", { message: "four" }, 4);

  assert.equal(diagnostics.recentEvents.length, 3);
  assert.equal(diagnostics.recentEvents[0].summary, '{"message":"two"}');
  assert.equal(diagnostics.recentEvents[2].timestamp, 4);
  assert.ok(diagnostics.recentEvents.every((event) => event.summary.length <= 320));
});

test("stored keys and auth/token material are scrubbed from all report sections", () => {
  const key = "sk-ant-api03-literal-stored-key-123456789";
  const diagnostics = new DiagnosticsBuffer({ secrets: [key] });
  diagnostics.setContext({
    provider: "anthropic",
    model: "claude-test",
    fenWebVersion: "0.0.0",
    userAgent: "test-browser",
  });
  diagnostics.record("provider-error", {
    message: `request failed with ${key}`,
    headers: { "x-api-key": key, Authorization: `Bearer ${key}` },
    body: `raw body ${key}`,
  });
  const report = formatDiagnostics(
    {
      error: {
        message: `failed ${key}`,
        stack: `Error: failed ${key}\n at request (Authorization: Bearer ${key})`,
      },
      provider: "anthropic",
      model: "claude-test",
      fenVersion: "0.17.0",
      fenWebVersion: "0.0.0",
      userAgent: "test-browser",
      events: diagnostics.recentEvents,
      previewConsoleTail: [`preview saw ${key}`],
      hostConsole: [{ level: "error", message: `host saw ${key}` }],
    },
    [key],
  );

  assert.equal(report.includes(key), false);
  assert.ok(report.includes("[REDACTED]"));
  assert.ok(report.includes("Preview console (tail)"));
  assert.ok(report.includes("Host console (recent)"));
});

test("scrubbing covers header styles, bearer tokens, and token-looking strings", () => {
  const longToken = "Abcdef0123456789XYZuvw9876543210-token";
  const value = scrubSecrets(
    `x-api-key: abc Authorization: Bearer bearer-token-123456789\n${longToken}`,
  );
  assert.match(value, /x-api-key: \[REDACTED\]/i);
  assert.match(value, /Authorization: \[REDACTED\]/i);
  assert.equal(value.includes(longToken), false);
});

test("summaries are single-line and bounded before entering the ring", () => {
  const summary = summarizePayload({ text: "x".repeat(2000), nested: { value: "y" } });
  assert.equal(summary.includes("\n"), false);
  assert.ok(summary.length <= 320);
});

test("summarizePayload survives throwing getters and circular references", () => {
  const payload: Record<string, unknown> = {};
  Object.defineProperty(payload, "hostile", {
    enumerable: true,
    get: () => {
      throw new Error("getter exploded");
    },
  });
  payload.self = payload;

  assert.doesNotThrow(() => summarizePayload(payload));
  const summary = summarizePayload(payload);
  assert.match(summary, /unreadable/);
  assert.match(summary, /Circular/);
});

test("summarizePayload handles non-Error throwables without throwing", () => {
  const throwable = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwable, "message", {
    enumerable: true,
    get: () => {
      throw new Error("message getter exploded");
    },
  });
  Object.defineProperty(throwable, "stack", {
    enumerable: true,
    get: () => {
      throw new Error("stack getter exploded");
    },
  });

  const diagnostics = new DiagnosticsBuffer();
  assert.doesNotThrow(() => summarizePayload(throwable));
  assert.doesNotThrow(() => diagnostics.recordError(throwable));
  assert.match(diagnostics.snapshot(), /unreadable|unprintable/);
});

test("summary truncation does not split a Unicode surrogate pair", () => {
  const summary = summarizePayload("😀".repeat(400));
  const summaryCharacters = Array.from(summary);
  assert.equal(summary.endsWith("…"), true);
  assert.equal(summary.includes("�"), false);
  assert.equal(summaryCharacters.at(-2), "😀");
});

test("header names remain useful while sensitive maps and only secret strings redact", () => {
  const summary = summarizePayload({
    headerNames: ["authorization", "content-type"],
    headers: { authorization: "Bearer live-secret" },
    tokenCount: 7,
    enabled: false,
    keymap: "Ctrl-K",
  });
  assert.match(summary, /headerNames/);
  assert.match(summary, /content-type/);
  assert.match(summary, /\"tokenCount\":7/);
  assert.match(summary, /\"enabled\":false/);
  assert.match(summary, /\"keymap\":\"Ctrl-K\"/);
  assert.equal(summary.includes("live-secret"), false);
});

test("build diagnostics use a non-hardcoded fen version fallback in node tests", () => {
  assert.equal(typeof FEN_VERSION, "string");
  assert.notEqual(FEN_VERSION, "0.17.0", "node tests should not depend on a hardcoded source constant");
});

test("recordError does not duplicate the most recent fatal", () => {
  const diagnostics = new DiagnosticsBuffer();
  const error = new Error("fatal");
  diagnostics.recordError(error);
  diagnostics.recordError(error);
  assert.equal(diagnostics.recentEvents.length, 1);
  assert.equal(diagnostics.recentEvents[0].kind, "error");
});

test("bus events can supply provider/model metadata without retaining raw payloads", () => {
  const diagnostics = new DiagnosticsBuffer();
  const key = "short-stored-key";
  diagnostics.addSecret(key);
  diagnostics.recordBusEvent({
    type: "set-status-info",
    info: { provider: "anthropic", model: "claude", apiKey: key },
  });
  const report = diagnostics.snapshot();
  assert.match(report, /Provider: anthropic/);
  assert.match(report, /Model: claude/);
  assert.equal(report.includes(key), false);
});

test("diagnostics read the live preview tail without draining it", () => {
  const diagnostics = new DiagnosticsBuffer();
  let tail: readonly unknown[] = [{ level: "error", args: ["boom"], stack: "Error: boom" }];
  diagnostics.setPreviewConsoleTailProvider(() => tail);
  const report = diagnostics.snapshot();
  assert.match(report, /Preview console \(tail\)/);
  assert.match(report, /Error: boom/);
  assert.deepEqual(tail, [{ level: "error", args: ["boom"], stack: "Error: boom" }]);
});

test("diagnostics cap the preview tail at the last 25 entries", () => {
  const diagnostics = new DiagnosticsBuffer();
  const tail = Array.from({ length: PREVIEW_DIAGNOSTICS_TAIL_LIMIT + 5 }, (_, i) => `entry-${i}`);
  diagnostics.setPreviewConsoleTailProvider(() => tail);
  const report = diagnostics.snapshot();
  assert.equal(report.includes("entry-0"), false);
  assert.equal(report.includes("entry-4"), false);
  assert.equal(report.includes("entry-5"), true);
  assert.equal(report.includes("entry-29"), true);
});

test("a report without an error is still useful on demand", () => {
  const report = formatDiagnostics({
    provider: "anthropic",
    model: "claude",
    fenVersion: "0.17.0",
    fenWebVersion: "0.0.0",
    userAgent: "UA",
    events: [],
  });
  assert.match(report, /^# fen-web diagnostics/);
  assert.match(report, /\(none\)/);
  assert.equal(report.includes("## Error"), false);
});
