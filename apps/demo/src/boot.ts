import {
  createFenRuntime,
  type FenRuntime,
  type FenSource,
} from "@fen-web/runtime";
import {
  IndexedDbKv,
  SyncKvCache,
  WebHostDomApply,
  WebHostFetch,
  FetchPoller,
  normalizeOps,
  type DomOp,
} from "@fen-web/bindings";
import { buildDemoSources } from "./sources.js";

// Vendored VM sources bundled as raw text (the runtime's Node fs readers
// don't run in-page — see docs/runtime/boot.md's browser note).
import fennelSource from "../../../packages/runtime/vendor/fennel-1.6.0.lua?raw";
import cjsonStubSource from "../../../packages/runtime/vendor/cjson_stub.lua?raw";
// The fen-web fetch backend, installed by pre-setting package.loaded the same
// way fen.testing.stub-http! and packages/integration do.
import fetchBackendSource from "../../../packages/bindings/fnl/fen/util/http/backends/fetch.fnl?raw";

export interface DemoBootOptions {
  /** Anthropic API key. Read from IndexedDB by the settings layer; passed
   * straight to the agent and, from there, only to api.anthropic.com. */
  apiKey: string;
  /** Provider id (only "anthropic" wired today; see docs/apps/demo.md). */
  provider?: string;
  /** Model id; defaults to the provider's default when omitted. */
  model?: string;
  /** Virtual-FS working directory the agent operates in. */
  cwd?: string;
  /** IndexedDB database name (kept overridable for tests). */
  dbName?: string;
}

export interface DemoSession {
  /** Await pending kv write-backs (session persistence durability). */
  flush(): Promise<void>;
  /** Tear down the run loop and close the VM. */
  stop(): void;
}

/** Pre-set package.loaded["fen.util.http.backend"] to the bundled fen-web
 * fetch backend, compiled in-VM — the mechanism fetch.fnl's own header
 * documents (a package.loaded assignment, not a searcher substitution). */
async function installFetchBackend(rt: FenRuntime, src: string): Promise<void> {
  rt.lua.global.set("__fetch_backend_src", src);
  await rt.doString(`
    local compiled = assert(fennel.compileString(__fetch_backend_src,
      {filename = "fen.util.http.backend", ["module-name"] = "fen.util.http.backend"}))
    local chunk = assert(load(compiled, "@fen.util.http.backend", "t"))
    package.loaded["fen.util.http.backend"] = chunk()
  `);
}

/**
 * Boot the wasmoon VM, wire the host primitives (kv/dom/fetch), and drive
 * the demo presenter's turn loop (fen_web.demo.boot/run) inside the runtime
 * coroutine pump. This is the "install __fen_host.dom_apply and boot the
 * runtime + demo presenter end to end" wiring deferred from #6's PR to #7.
 */
export async function bootDemo(
  opts: DemoBootOptions,
  sources: Map<string, FenSource> = buildDemoSources(),
): Promise<DemoSession> {
  const kvBacking = new IndexedDbKv(opts.dbName ?? "fen-web-demo");
  // fen's kv-backed seams (sessions, fs_kv) call kv synchronously; mirror
  // the store into a synchronous cache at boot (see SyncKvCache).
  const kv = await SyncKvCache.load(kvBacking);

  const dom = new WebHostDomApply();
  const poller = new FetchPoller(new WebHostFetch());

  const rt = await createFenRuntime({
    sources,
    fennelSource,
    preload: { cjson: cjsonStubSource },
    host: {
      kv,
      dom_apply: (ops: unknown) => dom.apply(normalizeOps(ops as DomOp[])),
      fetch_start: (fetchOpts: unknown) => poller.start(fetchOpts as never),
      fetch_poll: (id: number) => poller.poll(id),
      fetch_dispose: (id: number) => poller.dispose(id),
    },
  });

  await installFetchBackend(rt, fetchBackendSource);

  rt.lua.global.set("__demo_opts", {
    cwd: opts.cwd ?? "/workspace",
    provider: opts.provider ?? "anthropic",
    model: opts.model,
    "api-key": opts.apiKey,
  });

  const pump = await rt.createCoroutinePump(
    `function() return (require "fen_web.demo.boot").run(__demo_opts) end`,
  );

  let stopped = false;
  // Drive the presenter loop one resume per animation frame: each pump()
  // runs one presenter frame (drain input, tick any in-flight turn, render
  // the diff, yield). rAF paces to the display and pauses on a hidden tab;
  // the JS event loop runs between frames so pending host.fetch promises
  // (and kv write-backs) make progress. Falls back to setTimeout off-DOM.
  const schedule =
    typeof requestAnimationFrame === "function"
      ? (fn: () => void) => requestAnimationFrame(fn)
      : (fn: () => void) => setTimeout(fn, 16);

  const step = async () => {
    if (stopped) return;
    let status: string;
    try {
      status = await pump.pump();
    } catch (err) {
      // A presenter/turn crash shouldn't silently freeze the page.
      console.error("fen-web demo: run loop crashed", err);
      stopped = true;
      return;
    }
    if (status === "suspended" && !stopped) schedule(() => void step());
  };
  void step();

  return {
    flush: () => kv.flush(),
    stop: () => {
      stopped = true;
      rt.close();
    },
  };
}
