import {
  createFenRuntime,
  type FenRuntime,
  type FenSource,
} from "@fen-web/runtime";
import {
  FetchPoller,
  normalizeOps,
  type DomOp,
  type HostFetch,
  type HostPreview,
} from "@fen-web/bindings";

// The runtime/host wiring for the demo, deliberately kept free of any
// browser-only (`?raw` import, IndexedDB, real DOM/fetch) coupling so this
// exact code path is exercised by src/bootTurn.test.ts as well as the page.
// The browser-specific assembly (bundled VM sources, IndexedDB kv, real
// DOM/fetch) lives in browserBoot.ts, which supplies the deps below.

export interface DemoBootOptions {
  /** Provider id — only "anthropic" is wired today (see docs/apps/demo.md).
   * Anything else is rejected up front rather than silently routed to
   * Anthropic. The API key is NOT passed here: it is resolved in-VM via
   * `os.getenv("<VAR>")` → kv path `env/apikey/<VAR>` (docs/platform/shims.md),
   * the same credential seam the desktop provider uses. */
  provider?: string;
  /** Model id; defaults to the provider's default when omitted. */
  model?: string;
  /** Virtual-FS working directory the agent operates in. */
  cwd?: string;
}

/** Host primitives + bundled VM sources bootDemo needs, injected so the
 * browser page and the node test can each supply their own (real vs fake). */
export interface DemoRuntimeDeps {
  /** `createFenRuntime` source map (bundle glob in the browser, fs walk in tests). */
  sources: Map<string, FenSource>;
  /** fen-web fetch backend Fennel source, compiled in-VM and pre-set as
   * `package.loaded["fen.util.http.backend"]`. */
  fetchBackendSource: string;
  /** Synchronous kv view over the store (SyncKvCache in the browser, a
   * table-backed stub in tests). The API key must already be present under
   * `env/apikey/<VAR>` before boot. */
  kv: unknown;
  /** DOM sink: WebHostDomApply in the browser, FakeDom in tests. */
  dom: { apply(ops: DomOp[]): unknown };
  /** Sandboxed-iframe preview host: WebHostPreview in the browser, FakePreview
   * in tests. Drives the preview.* tools (fen-web#8). */
  preview: HostPreview;
  /** HostFetch transport: WebHostFetch in the browser, ScriptedFetch in tests. */
  fetch: HostFetch;
  /** Vendored Fennel source (required in the browser; omit in node, which
   * loads it from the runtime package). */
  fennelSource?: string;
  /** cjson preload source (required in the browser; omit in node). */
  cjsonSource?: string;
  /** Await pending kv write-backs (SyncKvCache.flush); optional in tests. */
  flush?: () => Promise<void>;
  /** Frame scheduler; defaults to rAF (browser) / setTimeout (off-DOM). */
  schedule?: (fn: () => void) => void;
}

export interface DemoSession {
  /** Await pending kv write-backs (session persistence durability). */
  flush(): Promise<void>;
  /** Cooperatively tear down: ask the presenter run loop to quit at the next
   * frame so presenter shutdown, session close, and the :agent-shutdown
   * lifecycle event all run, then close the VM. Resolves once torn down. */
  stop(): Promise<void>;
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
 * Boot the VM, wire the host primitives (kv/dom/fetch), and drive the demo
 * presenter's turn loop (fen_web.demo.boot/run) inside the runtime coroutine
 * pump. Credential resolution happens in-VM against `deps.kv`; only
 * cwd/provider/model are staged to Lua (no plaintext key in a JS global).
 */
export async function bootDemo(
  opts: DemoBootOptions,
  deps: DemoRuntimeDeps,
): Promise<DemoSession> {
  const provider = opts.provider ?? "anthropic";
  if (provider !== "anthropic") {
    throw new Error(
      `fen-web demo: unsupported provider "${provider}"; only "anthropic" is wired today`,
    );
  }

  const poller = new FetchPoller(deps.fetch);

  const rt = await createFenRuntime({
    sources: deps.sources,
    ...(deps.fennelSource ? { fennelSource: deps.fennelSource } : {}),
    ...(deps.cjsonSource ? { preload: { cjson: deps.cjsonSource } } : {}),
    host: {
      kv: deps.kv,
      dom_apply: (ops: unknown) => deps.dom.apply(normalizeOps(ops as DomOp[])),
      fetch_start: (fetchOpts: unknown) => poller.start(fetchOpts as never),
      fetch_poll: (id: number) => poller.poll(id),
      fetch_dispose: (id: number) => poller.dispose(id),
      // host.preview: setHtml (preview.refresh) + the async postMessage RPC
      // bridge (preview.query/click/fill/eval/screenshot). Mirrors the
      // fetch start/poll/dispose shape so the Fennel tools yield between
      // polls (docs/bindings/preview.md).
      preview_set_html: (html: unknown) => deps.preview.setHtml(String(html)),
      preview_rpc_start: (req: unknown) =>
        deps.preview.rpcStart(req as never),
      preview_rpc_poll: (id: number) => deps.preview.rpcPoll(id),
      preview_rpc_dispose: (id: number) => deps.preview.rpcDispose(id),
    },
  });

  await installFetchBackend(rt, deps.fetchBackendSource);

  rt.lua.global.set("__demo_opts", {
    cwd: opts.cwd ?? "/workspace",
    provider,
    model: opts.model,
  });

  const pump = await rt.createCoroutinePump(
    `function() return (require "fen_web.demo.boot").run(__demo_opts) end`,
  );

  const schedule =
    deps.schedule ??
    (typeof requestAnimationFrame === "function"
      ? (fn: () => void) => requestAnimationFrame(fn)
      : (fn: () => void) => setTimeout(fn, 16));

  let closed = false;
  let stopResolve: (() => void) | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      rt.close();
    } finally {
      stopResolve?.();
    }
  };

  // Drive the presenter loop one resume per animation frame: each pump()
  // runs one presenter frame (drain input, tick any in-flight turn, render
  // the diff, yield). rAF paces to the display and pauses on a hidden tab;
  // the JS event loop runs between frames so pending host.fetch promises
  // (and kv write-backs) make progress. When the run loop returns (normal
  // completion or a cooperative stop's quit), the coroutine goes "dead" and
  // we close the VM.
  const step = async () => {
    if (closed) return;
    let status: string;
    try {
      status = await pump.pump();
    } catch (err) {
      console.error("fen-web demo: run loop crashed", err);
      finish();
      return;
    }
    if (status === "suspended") {
      if (!closed) schedule(() => void step());
      return;
    }
    finish();
  };
  void step();

  return {
    flush: () => deps.flush?.() ?? Promise.resolve(),
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        stopResolve = resolve;
        // Ask the presenter run loop to quit cooperatively; the scheduled
        // step() loop then drains one more frame, the loop exits, boot.run
        // runs teardown, the coroutine dies, and finish() closes the VM.
        try {
          const requestStop = rt.lua.global.get("__fen_demo_request_stop") as unknown;
          if (typeof requestStop === "function") {
            (requestStop as () => void)();
          } else {
            // No cooperative hook (booted but not yet in the run loop):
            // fall back to a hard close so stop() still resolves.
            finish();
          }
        } catch (err) {
          console.error("fen-web demo: cooperative stop failed", err);
          finish();
        }
      }),
  };
}
