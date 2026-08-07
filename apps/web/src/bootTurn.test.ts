import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFenTree, type FenSource } from "@fen-web/runtime";
import {
  FakeDom,
  FakePreview,
  FetchPoller,
  type DomOp,
  type FetchRequestOptions,
  type FetchResult,
  type HostFetch,
  type HostKv,
  ScriptedFetch,
  SyncKvCache,
  seedIfEmptyKv,
  validateStarterFiles,
} from "@fen-web/bindings";
import { DiagnosticsBuffer } from "./diagnostics.js";
import { bootDemo, buildDemoHostTable, type DemoRuntimeDeps } from "./boot.js";

// End-to-end proof that the #7 wiring boots the runtime + bindings + DOM
// presenter and runs one real agent turn: it invokes the *actual* exported
// bootDemo (the same function the browser page's browserBoot.ts calls),
// injecting node-side host primitives — a synchronous table-backed kv, a
// FakeDom, and a recording ScriptedFetch — instead of the browser's
// IndexedDB/real-DOM/real-fetch. This covers the whole Fennel + boot.ts
// seam: source assembly, fetch-backend install, __demo_opts staging, the
// in-VM `os.getenv` credential resolution, the run-loop scheduler, and the
// cooperative stop() path. The browser-only glue (IndexedDbKv/SyncKvCache,
// WebHost{DomApply,Fetch}, the `?raw` bundling in browserBoot.ts) is covered
// by typecheck.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fenPackages = path.resolve(repoRoot, "fen", "packages");
const fenExtensions = path.resolve(repoRoot, "fen", "extensions");
const bindingsFnl = path.resolve(repoRoot, "packages", "bindings", "fnl");
const platformFnl = path.resolve(repoRoot, "packages", "platform", "fnl");
const demoFnl = path.resolve(here, "..", "fnl");

const KEY = "test-key";
const REPLY = "Hello from Claude";

function buildSources(): Map<string, FenSource> {
  const sources = loadFenTree([
    path.join(fenPackages, "core", "src"),
    path.join(fenPackages, "util", "src"),
    // fen.run_state / turn_submit / turn_lifecycle / session_lifecycle live
    // in the `fen.*` package; the demo boot reuses them (see sources.ts).
    path.join(fenPackages, "fen", "src"),
  ]);
  for (const [name, src] of loadFenTree([platformFnl, demoFnl])) sources.set(name, src);

  // Flat provider dirs (real dotted names come from a rockspec, not the
  // directory layout) — same treatment as turn.test.ts and sources.ts.
  const anthropicDir = path.join(fenExtensions, "adapters", "providers", "anthropic");
  const sharedDir = path.join(fenExtensions, "adapters", "providers", "shared");
  const manual: Record<string, string> = {
    "fen.extensions.provider_anthropic.anthropic_messages": path.join(
      anthropicDir,
      "anthropic_messages.fnl",
    ),
    "fen.extensions.provider_anthropic": path.join(anthropicDir, "init.fnl"),
    "fen.extensions.provider_anthropic.manifest": path.join(anthropicDir, "manifest.fnl"),
    "fen.extensions.provider_shared.streaming": path.join(sharedDir, "streaming.fnl"),
    "fen.extensions.provider_shared.retry": path.join(sharedDir, "retry.fnl"),
  };
  for (const [name, file] of Object.entries(manual)) {
    sources.set(name, { lang: "fnl", src: readFileSync(file, "utf8") });
  }
  return sources;
}

function fetchBackendSource(): string {
  return readFileSync(
    path.join(bindingsFnl, "fen", "util", "http", "backends", "fetch.fnl"),
    "utf8",
  );
}

function sourcesWithRunFailure(message: string, yieldFirst = false): Map<string, FenSource> {
  const sources = buildSources();
  const boot = sources.get("fen_web.web.boot");
  assert.ok(boot, "test source map should contain the web boot module");
  const yieldExpr = yieldFirst ? "  (coroutine.yield)\n" : "";
  sources.set("fen_web.web.boot", {
    ...boot,
    src: `${boot.src}\n(fn M.run [_ctx]\n${yieldExpr}  (error "${message}"))\nM\n`,
  });
  return sources;
}

async function drainTasks(
  tasks: (() => void)[],
  condition: () => boolean,
  maxMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < maxMs) {
    const task = tasks.shift();
    if (task) task();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Read the real starter files from disk (the browser bundles them via
 * import.meta.glob in src/starter.ts; node reads them straight off the tree),
 * keyed by absolute vfs path — the same shape bootDemo stages for the seeder. */
function starterFilesFromDisk(): Record<string, string> {
  const dir = path.resolve(here, "..", "starter");
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    files[`/${name}`] = readFileSync(path.join(dir, name), "utf8");
  }
  return files;
}

/** A table-backed synchronous kv (the SyncKv contract) seeded with the API
 * key under the exact path the `fen.util.path.backend` stub serves for
 * in-VM `path.getenv("<VAR>")`. */
function makeSyncKv(backing?: Map<string, string>) {
  const store = backing ?? new Map<string, string>();
  store.set("env/apikey/ANTHROPIC_API_KEY", KEY);
  return {
    sync: true as const,
    get: (k: string) => store.get(k),
    put: (k: string, v: string) => void store.set(k, v),
    delete: (k: string) => void store.delete(k),
    list: (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    store,
  };
}

/** Wrap a HostFetch to record the request options each call receives, so the
 * test can assert the request URL and auth/CORS headers the agent sends. */
function recordingFetch(inner: HostFetch): { fetch: HostFetch; requests: FetchRequestOptions[] } {
  const requests: FetchRequestOptions[] = [];
  return {
    requests,
    fetch: {
      async fetch(opts: FetchRequestOptions): Promise<FetchResult> {
        requests.push(opts);
        return inner.fetch(opts);
      },
    },
  };
}

/** One Anthropic Messages streaming completion: typed SSE events matching
 * anthropic_messages.fnl's process-stream-event!. */
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

function anthropicToolUseSse(name: string, id = "call-1"): string[] {
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  return [
    frame({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
    frame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
    frame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
    frame({ type: "message_stop" }),
  ];
}

function transcriptText(dom: FakeDom): string {
  return dom
    .childIds("fen-transcript")
    .map((id) => dom.get(id).text)
    .join("\n");
}

test("boot host exposes preview_console_drain as bounded JSON text", () => {
  const preview = new FakePreview();
  preview.recordConsole({ level: "error", args: ["buffered"], stack: "Error: buffered" });
  const hostTable = buildDemoHostTable(
    {
      sources: new Map(),
      fetchBackendSource: "",
      kv: {},
      dom: { apply: () => undefined },
      preview,
      fetch: new ScriptedFetch(),
    },
    new FetchPoller(new ScriptedFetch()),
  );

  const drain = hostTable.preview_console_drain as () => unknown;
  const text = drain();
  assert.equal(typeof text, "string");
  if (typeof text !== "string") throw new Error("preview_console_drain violated its JSON-text contract");
  assert.match(text, /buffered/);
});

test("bootDemo drives the demo presenter through one Anthropic turn end to end", async () => {
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicSse(REPLY),
  });
  const recorder = recordingFetch(scripted);
  const dom = new FakeDom("fen-app");
  const kv = makeSyncKv();
  const diagnostics = new DiagnosticsBuffer();

  // First-load seeding (fen-web#9) is a durable, atomic step against the
  // persistent store BEFORE the VM boots (browserBoot.ts does this with
  // IndexedDbKv.seedIfEmpty; browsers get transactional atomicity). Node has
  // no IndexedDB, so mirror the same shared seed helper over the table store
  // the sync kv reads, exactly as the browser does before snapshotting.
  const asyncKv: HostKv = {
    get: async (k) => kv.store.get(k),
    put: async (k, v) => void kv.store.set(k, v),
    delete: async (k) => void kv.store.delete(k),
    list: async (p) =>
      [...kv.store.keys()].filter((k) => k.startsWith(p ?? "")).sort(),
  };
  const seeded = await seedIfEmptyKv(asyncKv, validateStarterFiles(starterFilesFromDisk()));
  assert.ok(seeded, "a fresh store should seed the starter project");

  // Deterministic, bounded scheduler: bootDemo pushes each next frame here
  // and the test drains it, so no wall-clock rAF/timeout timing is involved.
  const tasks: (() => void)[] = [];
  const schedule = (fn: () => void) => void tasks.push(fn);
  const runUntil = async (cond: () => boolean, maxMs = 8000): Promise<void> => {
    const start = Date.now();
    while (!cond() && Date.now() - start < maxMs) {
      const t = tasks.shift();
      if (t) t();
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const deps: DemoRuntimeDeps = {
    sources: buildSources(),
    fetchBackendSource: fetchBackendSource(),
    kv,
    dom,
    preview: new FakePreview(),
    fetch: recorder.fetch,
    schedule,
    diagnostics,
  };

  const session = await bootDemo(
    { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 32000 },
    deps,
  );

  // Wait for the presenter skeleton to build and the run loop to be live.
  await runUntil(() => dom.exists("fen-inputbar") && dom.exists("fen-input"));
  assert.ok(dom.exists("fen-inputbar"), "presenter skeleton should be built");

  // First-load seeding (fen-web#9): the curated starter todo app was seeded
  // into the vfs ("fs:") keyspace before boot, so the preview-driving loop is
  // demoable in one click and the in-VM sync kv view already sees it. Assert
  // the entry + its same-tree assets landed, plus the seed-complete marker.
  assert.ok(
    kv.store.get("fs:/index.html")?.includes("<title>Starter todo</title>"),
    "first load should seed the starter index.html into the vfs",
  );
  assert.ok(kv.store.has("fs:/app.js"), "first load should seed app.js");
  assert.ok(kv.store.has("fs:/styles.css"), "first load should seed styles.css");
  assert.ok(
    kv.store.get("seed:starter-complete") !== undefined,
    "seeding should write the seed-complete marker",
  );

  // Simulate a user submitting a prompt.
  dom.apply([{ op: "prop", id: "fen-input", name: "value", value: "hi" } as DomOp]);
  dom.emit("fen-inputbar", "submit");

  // Pump until the turn completes and both messages are persisted.
  const entryCount = () => [...kv.store.keys()].filter((k) => k.includes(":entry:")).length;
  await runUntil(() => entryCount() >= 2);

  const transcript = transcriptText(dom);
  assert.ok(transcript.includes("> hi"), `expected the user row, got:\n${transcript}`);
  assert.ok(transcript.includes(REPLY), `expected the streamed assistant reply, got:\n${transcript}`);
  assert.equal(entryCount(), 2, `expected 2 persisted entries, got ${entryCount()}`);

  // The agent sent exactly one request, to Anthropic, carrying the key
  // resolved in-VM from kv (env/apikey/ANTHROPIC_API_KEY) plus the browser
  // CORS opt-in header the fetch backend adds for that host.
  assert.equal(recorder.requests.length, 1, "expected exactly one provider request");
  const req = recorder.requests[0];
  assert.equal(req.url, "https://api.anthropic.com/v1/messages", "request URL should be Anthropic");
  const parsedBody = req.body
    ? (JSON.parse(req.body) as { model?: string; max_tokens?: number })
    : undefined;
  assert.equal(parsedBody?.model, "claude-sonnet-5");
  assert.equal(
    parsedBody?.max_tokens,
    32000,
    "catalog max_tokens must reach the wire, not the 8192 fallback",
  );
  const headers = (req.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-api-key"], KEY, "auth header should carry the in-VM-resolved key");
  assert.equal(
    headers["anthropic-dangerous-direct-browser-access"],
    "true",
    "transport should add the Anthropic direct-browser CORS header",
  );

  // Fetch diagnostics retain only the useful request shape: header names are
  // visible, while body/header values are never copied into the ring.
  const fetchStart = diagnostics.recentEvents.find((event) => event.kind === "fetch:start");
  const fetchDone = diagnostics.recentEvents.find((event) => event.kind === "fetch:done");
  assert.ok(fetchStart, "fetch:start should be recorded");
  assert.ok(fetchDone, "fetch:done should be recorded");
  const startShape = JSON.parse(fetchStart.summary) as Record<string, unknown>;
  const doneShape = JSON.parse(fetchDone.summary) as Record<string, unknown>;
  assert.deepEqual(Object.keys(startShape).sort(), ["headerNames", "method", "url"]);
  assert.ok(Array.isArray(startShape.headerNames));
  assert.equal(startShape.url, req.url);
  assert.equal(doneShape.status, 200);
  assert.equal(typeof doneShape.chunksThisPoll, "number");
  assert.equal("body" in doneShape, false);
  assert.equal("headers" in doneShape, false);
  assert.equal(
    diagnostics.recentEvents.some((event) => event.kind === "runtime-tick"),
    false,
    "control ticks must not consume diagnostics ring entries",
  );
  // Positive guard on the Fennel bus tap: fetch:* events come from the JS
  // side, so require at least one event that could only have crossed the
  // presenter's diagnostics_event seam. A broken tap must fail this, not
  // pass vacuously via the negative assertion above.
  assert.ok(
    diagnostics.recentEvents.some((event) => !event.kind.startsWith("fetch:")),
    "at least one presenter bus event should cross the diagnostics seam",
  );

  // Cooperative shutdown: stop() asks the run loop to quit and resolves once
  // the VM is torn down; drive frames until it settles.
  let stopped = false;
  const stopPromise = session.stop().then(() => {
    stopped = true;
  });
  await runUntil(() => stopped, 3000);
  await stopPromise;
  assert.ok(stopped, "session.stop() should resolve after cooperative teardown");
});

test("bootDemo preview_console crosses the real wasmoon boundary as JSON text", async () => {
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicToolUseSse("preview_console"),
  });
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicSse("done"),
  });
  const recorder = recordingFetch(scripted);
  const preview = new FakePreview();
  preview.recordConsole({ level: "error", args: ["buffered"], stack: "Error: buffered" });
  const dom = new FakeDom("fen-app");
  const kv = makeSyncKv();
  const tasks: (() => void)[] = [];
  const schedule = (fn: () => void) => void tasks.push(fn);
  const runUntil = async (cond: () => boolean, maxMs = 8000): Promise<void> => {
    const start = Date.now();
    while (!cond() && Date.now() - start < maxMs) {
      const task = tasks.shift();
      if (task) task();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  let fatal: unknown;
  const session = await bootDemo(
    { provider: "anthropic", model: "claude-haiku-4-5" },
    {
      sources: buildSources(),
      fetchBackendSource: fetchBackendSource(),
      kv,
      dom,
      preview,
      fetch: recorder.fetch,
      schedule,
      onFatal: (err) => {
        fatal = err;
      },
    },
  );

  await runUntil(() => dom.exists("fen-input"));
  assert.ok(dom.exists("fen-input"), "presenter should boot before the tool call");
  dom.apply([{ op: "prop", id: "fen-input", name: "value", value: "inspect" } as DomOp]);
  dom.emit("fen-inputbar", "submit");
  await runUntil(() => recorder.requests.length >= 2 || fatal !== undefined);

  assert.equal(fatal, undefined, "preview_console should not crash at the JS/Lua boundary");
  assert.equal(recorder.requests.length, 2, "the tool turn should make a follow-up provider request");
  assert.match(
    recorder.requests[1].body ?? "",
    /buffered/,
    "the tool result must contain the entry that crossed the JS/Lua boundary",
  );
  assert.deepEqual(preview.drainConsole(), [], "preview_console should consume the buffered entry");
  let stopped = false;
  const stopPromise = session.stop().then(() => {
    stopped = true;
  });
  await runUntil(() => stopped);
  await stopPromise;
  assert.ok(stopped, "session.stop() should resolve after cooperative teardown");
});

test("bootDemo turns a raw JS preview-console array into a clean tool error", async () => {
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicToolUseSse("preview_console"),
  });
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: anthropicSse("recovered"),
  });
  const recorder = recordingFetch(scripted);
  const dom = new FakeDom("fen-app");
  const tasks: (() => void)[] = [];
  const schedule = (fn: () => void) => void tasks.push(fn);
  const runUntil = async (cond: () => boolean, maxMs = 8000): Promise<void> => {
    const start = Date.now();
    while (!cond() && Date.now() - start < maxMs) {
      const task = tasks.shift();
      if (task) task();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  let fatal: unknown;
  const session = await bootDemo(
    { provider: "anthropic", model: "claude-haiku-4-5" },
    {
      sources: buildSources(),
      fetchBackendSource: fetchBackendSource(),
      kv: makeSyncKv(),
      dom,
      preview: new FakePreview(),
      fetch: recorder.fetch,
      schedule,
      // Deliberately violate the JS host contract with a raw array. The
      // wasmoon boundary must turn it into userdata, and the Fennel guard must
      // return a tool error instead of handing it to cjson or crashing.
      hostOverrides: {
        preview_console_drain: () => [{ level: "error", args: ["raw-array"] }],
      },
      onFatal: (err) => {
        fatal = err;
      },
    },
  );

  await runUntil(() => dom.exists("fen-input"));
  assert.ok(dom.exists("fen-input"), "presenter should boot before the tool call");
  dom.apply([{ op: "prop", id: "fen-input", name: "value", value: "inspect" } as DomOp]);
  dom.emit("fen-inputbar", "submit");
  await runUntil(() => recorder.requests.length >= 2 || fatal !== undefined);

  assert.equal(fatal, undefined, "a raw JS array should not crash the run loop");
  assert.equal(recorder.requests.length, 2, "the tool error should still complete the turn");
  assert.match(recorder.requests[1].body ?? "", /non-JSON data/);
  let stopped = false;
  const stopPromise = session.stop().then(() => {
    stopped = true;
  });
  await runUntil(() => stopped);
  await stopPromise;
  assert.ok(stopped, "session.stop() should resolve after cooperative teardown");
});

test("run-loop crash flushes before closing and reports a fatal error", async () => {
  const tasks: (() => void)[] = [];
  const events: string[] = [];
  let fatal: unknown;
  const kv = makeSyncKv();
  const session = await bootDemo(
    { provider: "anthropic" },
    {
      sources: sourcesWithRunFailure("run-loop test crash", true),
      fetchBackendSource: fetchBackendSource(),
      kv,
      dom: new FakeDom("fen-app"),
      preview: new FakePreview(),
      fetch: new ScriptedFetch(),
      schedule: (fn) => void tasks.push(fn),
      flush: async () => {
        events.push("flush");
      },
      dispose: () => {
        events.push("dispose");
      },
      onFatal: (err) => {
        events.push("fatal");
        fatal = err;
      },
    },
  );

  await drainTasks(tasks, () => fatal !== undefined);
  assert.match(String(fatal), /run-loop test crash/);
  assert.deepEqual(
    events,
    ["flush", "dispose", "fatal"],
    "flush and disposal must precede fatal reporting",
  );
  await session.stop();
});

test("restart boots a fresh working session with the persisted vfs", async () => {
  const tasks: (() => void)[] = [];
  const schedule = (fn: () => void) => void tasks.push(fn);
  const dom = new FakeDom("fen-app");
  // This map is only an async durable-store double. Exercising the real
  // IndexedDB path under node is out of scope; SyncKvCache is the browser
  // snapshot/write-back seam this test needs to verify.
  const durable = new Map<string, string>([["env/apikey/ANTHROPIC_API_KEY", KEY]]);
  const asyncBacking: HostKv = {
    get: async (key) => durable.get(key),
    put: async (key, value) => void durable.set(key, value),
    delete: async (key) => void durable.delete(key),
    list: async (prefix) => [...durable.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
  const firstKv = await SyncKvCache.load(asyncBacking);
  const makeDeps = (kv: unknown): DemoRuntimeDeps => ({
    sources: buildSources(),
    fetchBackendSource: fetchBackendSource(),
    kv,
    dom,
    preview: new FakePreview(),
    fetch: new ScriptedFetch(),
    schedule,
  });

  const first = await bootDemo({ provider: "anthropic" }, makeDeps(firstKv));
  await drainTasks(tasks, () => dom.exists("fen-input"));
  assert.ok(dom.exists("fen-input"), "first VM should boot the presenter");
  // Route the write through the first session's sync cache and wait for its
  // async backing write, rather than asserting against the backing Map.
  firstKv.put("fs:/restart.txt", "survives restart");
  await first.flush();
  let firstStopped = false;
  void first.stop().then(() => {
    firstStopped = true;
  });
  await drainTasks(tasks, () => firstStopped);
  assert.ok(firstStopped, "first VM should stop");

  // Simulate the browser's fresh SyncKvCache snapshot and the mount reset
  // performed by main.ts before the second VM's first DOM batch.
  dom.replaceChildren("fen-app");
  const secondKv = await SyncKvCache.load(asyncBacking);
  const second = await bootDemo({ provider: "anthropic" }, makeDeps(secondKv));
  await drainTasks(tasks, () => dom.exists("fen-input"));
  const secondChildren = dom.children("fen-app");
  assert.ok(dom.exists("fen-input"), "fresh VM should boot the presenter");
  assert.equal(new Set(secondChildren).size, secondChildren.length, "restart must not duplicate DOM ids");
  assert.equal(secondKv.get("fs:/restart.txt"), "survives restart", "second boot snapshot should see flushed vfs");
  assert.notStrictEqual(second, first, "restart must return a new session");
  let secondStopped = false;
  void second.stop().then(() => {
    secondStopped = true;
  });
  await drainTasks(tasks, () => secondStopped);
  assert.ok(secondStopped, "fresh VM should stop");
});

test("pre-pump setup failure flushes and reports a fatal error", async () => {
  const events: string[] = [];
  let fatal: unknown;
  await assert.rejects(
    () =>
      bootDemo(
        { provider: "anthropic" },
        {
          sources: buildSources(),
          // installFetchBackend compiles this before createCoroutinePump's
          // coroutine body can be pumped.
          fetchBackendSource: "(this is not valid fennel",
          kv: makeSyncKv(),
          dom: new FakeDom("fen-app"),
          preview: new FakePreview(),
          fetch: new ScriptedFetch(),
          flush: async () => {
            events.push("flush");
          },
          dispose: () => {
            events.push("dispose");
          },
          onFatal: (err) => {
            events.push("fatal");
            fatal = err;
          },
        },
      ),
  );
  assert.ok(fatal, "setup failure should reach the fatal callback");
  assert.deepEqual(
    events,
    ["flush", "dispose", "fatal"],
    "flush and disposal must precede fatal reporting",
  );
});

test("in-VM boot failure reaches the fatal callback", async () => {
  const tasks: (() => void)[] = [];
  let fatal: unknown;
  const session = await bootDemo(
    { provider: "anthropic" },
    {
      sources: sourcesWithRunFailure("in-VM boot test failure"),
      fetchBackendSource: fetchBackendSource(),
      kv: makeSyncKv(),
      dom: new FakeDom("fen-app"),
      preview: new FakePreview(),
      fetch: new ScriptedFetch(),
      schedule: (fn) => void tasks.push(fn),
      onFatal: (err) => {
        fatal = err;
      },
    },
  );

  await drainTasks(tasks, () => fatal !== undefined);
  assert.match(String(fatal), /in-VM boot test failure/);
  await session.stop();
});
