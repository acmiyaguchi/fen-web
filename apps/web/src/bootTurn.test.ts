import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFenTree, type FenSource } from "@fen-web/runtime";
import {
  FakeDom,
  FakePreview,
  type DomOp,
  type FetchRequestOptions,
  type FetchResult,
  type HostFetch,
  type HostKv,
  ScriptedFetch,
  seedIfEmptyKv,
  validateStarterFiles,
} from "@fen-web/bindings";
import { bootDemo, type DemoRuntimeDeps } from "./boot.js";

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
const OPENAI_KEY = "openai-test-key";
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
  const openaiDir = path.join(fenExtensions, "adapters", "providers", "openai");
  const sharedDir = path.join(fenExtensions, "adapters", "providers", "shared");
  const manual: Record<string, string> = {
    "fen.extensions.provider_anthropic.anthropic_messages": path.join(
      anthropicDir,
      "anthropic_messages.fnl",
    ),
    "fen.extensions.provider_anthropic": path.join(anthropicDir, "init.fnl"),
    "fen.extensions.provider_anthropic.manifest": path.join(anthropicDir, "manifest.fnl"),
    "fen.extensions.provider_openai.openai_completions": path.join(
      openaiDir,
      "openai_completions.fnl",
    ),
    "fen.extensions.provider_openai.openai_model_catalog": path.join(
      openaiDir,
      "openai_model_catalog.fnl",
    ),
    "fen.extensions.provider_shared": path.join(sharedDir, "init.fnl"),
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
 * key under the exact path the fs_kv shim maps `os.getenv("<VAR>")` to. */
function makeSyncKv() {
  const store = new Map<string, string>();
  store.set("env/apikey/ANTHROPIC_API_KEY", KEY);
  store.set("env/apikey/OPENAI_API_KEY", OPENAI_KEY);
  return {
    sync: true as const,
    get: (k: string) => store.get(k),
    put: (k: string, v: string) => void store.set(k, v),
    delete: (k: string) => void store.delete(k),
    list: (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    store,
  };
}

async function seedStarter(kv: ReturnType<typeof makeSyncKv>): Promise<void> {
  const asyncKv: HostKv = {
    get: async (k) => kv.store.get(k),
    put: async (k, v) => void kv.store.set(k, v),
    delete: async (k) => void kv.store.delete(k),
    list: async (p) =>
      [...kv.store.keys()].filter((key) => key.startsWith(p ?? "")).sort(),
  };
  const seeded = await seedIfEmptyKv(asyncKv, validateStarterFiles(starterFilesFromDisk()));
  assert.ok(seeded, "a fresh store should seed the starter project");
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

function openaiSse(text: string): string[] {
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const words = text.split(" ");
  return [
    ...words.map((word, index) =>
      frame({
        choices: [
          {
            index: 0,
            delta: { content: index === 0 ? word : " " + word },
            finish_reason: null,
          },
        ],
      }),
    ),
    frame({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: words.length, total_tokens: 8 + words.length },
    }),
    "data: [DONE]\n\n",
  ];
}

function transcriptText(dom: FakeDom): string {
  return dom
    .childIds("fen-transcript")
    .map((id) => dom.get(id).text)
    .join("\n");
}

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

  // First-load seeding (fen-web#9) is a durable, atomic step against the
  // persistent store BEFORE the VM boots (browserBoot.ts does this with
  // IndexedDbKv.seedIfEmpty; browsers get transactional atomicity). Node has
  // no IndexedDB, so mirror the same shared seed helper over the table store
  // the sync kv reads, exactly as the browser does before snapshotting.
  await seedStarter(kv);

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
  };

  const session = await bootDemo({ provider: "anthropic", model: "claude-haiku-4-5" }, deps);

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
  const headers = (req.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-api-key"], KEY, "auth header should carry the in-VM-resolved key");
  assert.equal(
    headers["anthropic-dangerous-direct-browser-access"],
    "true",
    "transport should add the Anthropic direct-browser CORS header",
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

test("bootDemo drives the demo presenter through one OpenAI Chat Completions turn end to end", async () => {
  const reply = "Hello from OpenAI";
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: openaiSse(reply),
  });
  const recorder = recordingFetch(scripted);
  const dom = new FakeDom("fen-app");
  const kv = makeSyncKv();
  await seedStarter(kv);

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

  const deps: DemoRuntimeDeps = {
    sources: buildSources(),
    fetchBackendSource: fetchBackendSource(),
    kv,
    dom,
    preview: new FakePreview(),
    fetch: recorder.fetch,
    schedule,
  };

  const session = await bootDemo({ provider: "openai" }, deps);
  await runUntil(() => dom.exists("fen-inputbar") && dom.exists("fen-input"));
  assert.ok(dom.exists("fen-inputbar"), "presenter skeleton should be built");

  dom.apply([{ op: "prop", id: "fen-input", name: "value", value: "hi" } as DomOp]);
  dom.emit("fen-inputbar", "submit");
  const entryCount = () => [...kv.store.keys()].filter((key) => key.includes(":entry:")).length;
  await runUntil(() => entryCount() >= 2);

  const transcript = transcriptText(dom);
  assert.ok(transcript.includes("> hi"), `expected the user row, got:\n${transcript}`);
  assert.ok(transcript.includes(reply), `expected the streamed assistant reply, got:\n${transcript}`);
  assert.equal(entryCount(), 2, `expected 2 persisted entries, got ${entryCount()}`);

  assert.equal(recorder.requests.length, 1, "expected exactly one provider request");
  const req = recorder.requests[0];
  assert.equal(req.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(JSON.parse(req.body ?? "{}").model, "gpt-5.4-nano");
  const headers = (req.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(headers["x-api-key"], undefined, "OpenAI should use Bearer auth");
  assert.equal(
    headers["anthropic-dangerous-direct-browser-access"],
    undefined,
    "OpenAI should not receive Anthropic's browser header",
  );

  let stopped = false;
  const stopPromise = session.stop().then(() => {
    stopped = true;
  });
  await runUntil(() => stopped, 3000);
  await stopPromise;
  assert.ok(stopped, "session.stop() should resolve after cooperative teardown");
});
