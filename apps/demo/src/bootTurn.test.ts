import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFenRuntime,
  loadFenTree,
  type FenRuntime,
  type FenSource,
} from "@fen-web/runtime";
import { FakeDom, FetchPoller, ScriptedFetch, normalizeOps, type DomOp } from "@fen-web/bindings";

// End-to-end proof that the #7 wiring boots the runtime + bindings + DOM
// presenter and runs one real agent turn: it drives the *actual*
// fen_web.demo.boot/run orchestration (the same Fennel the browser shell
// pumps) against a FakeDom host, a synchronous table-backed kv, and a
// scripted Anthropic Messages SSE stream. The browser-only glue
// (src/boot.ts's real DOM/IndexedDB/fetch, settings.ts) is covered by
// typecheck; this test covers the Fennel end of the seam, which is where
// the behavior lives (docs/architecture/fennel-first.md).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fenPackages = path.resolve(repoRoot, "fen", "packages");
const fenExtensions = path.resolve(repoRoot, "fen", "extensions");
const bindingsFnl = path.resolve(repoRoot, "packages", "bindings", "fnl");
const platformFnl = path.resolve(repoRoot, "packages", "platform", "fnl");
const demoFnl = path.resolve(here, "..", "fnl");

function buildSources(): Map<string, FenSource> {
  const sources = loadFenTree([
    path.join(fenPackages, "core", "src"),
    path.join(fenPackages, "util", "src"),
  ]);
  for (const [name, src] of loadFenTree([platformFnl, demoFnl])) sources.set(name, src);

  // Flat provider dirs (real dotted names come from a rockspec, not the
  // directory layout) — same treatment as turn.test.ts.
  const anthropicDir = path.join(fenExtensions, "adapters", "providers", "anthropic");
  const sharedDir = path.join(fenExtensions, "adapters", "providers", "shared");
  const manual: Record<string, string> = {
    "fen.extensions.provider_anthropic.anthropic_messages": path.join(
      anthropicDir,
      "anthropic_messages.fnl",
    ),
    "fen.extensions.provider_shared.streaming": path.join(sharedDir, "streaming.fnl"),
    "fen.extensions.provider_shared.retry": path.join(sharedDir, "retry.fnl"),
  };
  for (const [name, file] of Object.entries(manual)) {
    sources.set(name, { lang: "fnl", src: readFileSync(file, "utf8") });
  }
  return sources;
}

function makeSyncKv() {
  const store = new Map<string, string>();
  return {
    sync: true as const,
    get: (k: string) => store.get(k),
    put: (k: string, v: string) => void store.set(k, v),
    delete: (k: string) => void store.delete(k),
    list: (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    store,
  };
}

async function installFetchBackend(rt: FenRuntime) {
  const src = readFileSync(
    path.join(bindingsFnl, "fen", "util", "http", "backends", "fetch.fnl"),
    "utf8",
  );
  rt.lua.global.set("__fetch_backend_src", src);
  await rt.doString(`
    local compiled = assert(fennel.compileString(__fetch_backend_src,
      {filename = "fen.util.http.backend", ["module-name"] = "fen.util.http.backend"}))
    local chunk = assert(load(compiled, "@fen.util.http.backend", "t"))
    package.loaded["fen.util.http.backend"] = chunk()
  `);
}

/** One Anthropic Messages streaming completion: typed SSE events matching
 * anthropic_messages.fnl's process-stream-event! (message_start /
 * content_block_start(text) / content_block_delta(text_delta) /
 * content_block_stop / message_delta(stop_reason) / message_stop). */
function anthropicSse(text: string): string[] {
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const words = text.split(" ");
  return [
    frame({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ...words.map((w, i) =>
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: i === 0 ? w : " " + w },
      }),
    ),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: words.length } }),
    frame({ type: "message_stop" }),
  ];
}

function transcriptText(dom: FakeDom): string {
  return dom
    .childIds("fen-transcript")
    .map((id) => dom.get(id).text)
    .join("\n");
}

test("bootDemo drives the demo presenter through one Anthropic turn end to end", async () => {
  const REPLY = "Hello from Claude";
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicSse(REPLY),
  });
  const poller = new FetchPoller(scripted);
  const dom = new FakeDom("fen-app");
  const kv = makeSyncKv();

  const rt = await createFenRuntime({
    sources: buildSources(),
    host: {
      kv,
      dom_apply: (ops: unknown) => dom.apply(normalizeOps(ops as DomOp[])),
      fetch_start: (o: unknown) => poller.start(o as never),
      fetch_poll: (id: number) => poller.poll(id),
      fetch_dispose: (id: number) => poller.dispose(id),
    },
  });

  try {
    await installFetchBackend(rt);
    rt.lua.global.set("__demo_opts", {
      cwd: "/workspace",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      "api-key": "test-key",
    });

    const pump = await rt.createCoroutinePump(
      `function() return (require "fen_web.demo.boot").run(__demo_opts) end`,
    );

    // A few frames to build the skeleton and enter the run loop.
    for (let i = 0; i < 3; i++) await pump.pump();
    assert.ok(dom.exists("fen-inputbar"), "presenter skeleton should be built");
    assert.ok(dom.exists("fen-input"), "input field should exist");

    // Simulate a user submitting a prompt: set the input value, then fire
    // the form submit the presenter listens for.
    dom.apply([{ op: "prop", id: "fen-input", name: "value", value: "hi" } as DomOp]);
    dom.emit("fen-inputbar", "submit");

    // Pump until the turn completes and both messages are persisted (the
    // presenter run loop never returns on its own, so we can't wait for a
    // dead coroutine — we wait for the turn's side effects instead).
    const entryCount = () => [...kv.store.keys()].filter((k) => k.includes(":entry:")).length;
    let pumps = 0;
    while (entryCount() < 2 && pumps < 500) {
      await pump.pump();
      pumps += 1;
    }

    const transcript = transcriptText(dom);
    assert.ok(transcript.includes("> hi"), `expected the user row, got:\n${transcript}`);
    assert.ok(
      transcript.includes(REPLY),
      `expected the streamed assistant reply, got:\n${transcript}`,
    );

    // The session backend persisted the turn (user + assistant) into kv.
    assert.equal(entryCount(), 2, `expected 2 persisted entries, got ${entryCount()}`);
  } finally {
    rt.close();
  }
});
