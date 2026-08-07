import {
  createFenRuntime,
  type FenRuntime,
  type FenSource,
} from "@fen-web/runtime";
import {
  FetchPoller,
  normalizeOps,
  type DomOp,
  type FetchPollResult,
  type FetchRequestOptions,
  type HostFetch,
  type HostPreview,
} from "@fen-web/bindings";
import type { DiagnosticsBuffer } from "./diagnostics.js";

// The runtime/host wiring for the demo, deliberately kept free of any
// browser-only (`?raw` import, IndexedDB, real DOM/fetch) coupling so this
// exact code path is exercised by src/bootTurn.test.ts as well as the page.
// The browser-specific assembly (bundled VM sources, IndexedDB kv, real
// DOM/fetch) lives in browserBoot.ts, which supplies the deps below.

export interface DemoBootOptions {
  /** Provider id — only "anthropic" is wired today (see docs/apps/web.md).
   * Anything else is rejected up front rather than silently routed to
   * Anthropic. The API key is NOT passed here: it is resolved in-VM via
   * `path.getenv("<VAR>")` → kv path `env/apikey/<VAR>` served by the
   * preloaded `fen.util.path.backend` stub (docs/platform/shims.md),
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
   * `env/apikey/<VAR>` before boot; the first-load starter project
   * (fen-web#9) must also already be seeded into the durable store, since the
   * atomic/durable seed happens against the async backing before this
   * synchronous view is snapshotted (browserBoot.ts / IndexedDbKv.seedIfEmpty).
   */
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
  /** Browser-side diagnostics state; captured payloads are summarized by it. */
  diagnostics?: DiagnosticsBuffer;
  /** Called after a fatal boot/run-loop error has been flushed and the VM closed. */
  onFatal?: (err: unknown) => void | Promise<void>;
  /** Release per-boot host resources after the VM is closed. */
  dispose?: () => void | Promise<void>;
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
  /** Hard-close the VM and host resources without waiting for the presenter. */
  close(): Promise<void>;
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
 * presenter's turn loop (fen_web.web.boot/run) inside the runtime coroutine
 * pump. Credential resolution happens in-VM against `deps.kv`; only
 * cwd/provider/model are staged to Lua (no plaintext key in a JS global).
 */
export async function bootDemo(
  opts: DemoBootOptions,
  deps: DemoRuntimeDeps,
): Promise<DemoSession> {
  const provider = opts.provider ?? "anthropic";
  if (provider !== "anthropic" && provider !== "openai-codex") {
    throw new Error(
      `fen-web demo: unsupported provider "${provider}"; only "anthropic" and "openai-codex" are wired today`,
    );
  }

  const poller = new FetchPoller(deps.fetch);
  deps.diagnostics?.setContext({
    provider,
    ...(opts.model ? { model: opts.model } : {}),
  });

  const rt = await createFenRuntime({
    sources: deps.sources,
    ...(deps.fennelSource ? { fennelSource: deps.fennelSource } : {}),
    ...(deps.cjsonSource ? { preload: { cjson: deps.cjsonSource } } : {}),
    host: {
      kv: deps.kv,
      dom_apply: (ops: unknown) => deps.dom.apply(normalizeOps(ops as DomOp[])),
      // One-way Lua -> JS seam. DiagnosticsBuffer immediately retains only a
      // bounded scrubbed summary; JS never queries the VM mid-coroutine.
      // The Fennel side filters control events before this callback is called;
      // this catch is the second guard against a diagnostics bug poisoning a
      // live turn coroutine.
      diagnostics_event: (event: unknown) => {
        try {
          deps.diagnostics?.recordBusEvent(event);
        } catch {
          // Diagnostics are observational and must never affect the VM.
        }
      },
      // Never retain request bodies or header values: only URL/method and
      // header names enter the diagnostics ring. Record failures are isolated
      // from the request transport in both directions of the poll protocol.
      fetch_start: (fetchOpts: unknown) => {
        const options = fetchOpts as FetchRequestOptions;
        try {
          deps.diagnostics?.record("fetch:start", {
            url: options.url,
            method: options.method,
            headerNames: Object.keys(options.headers ?? {}).sort(),
          });
        } catch {
          // A diagnostics failure must not poison an in-flight request.
        }
        return poller.start(options);
      },
      fetch_poll: (id: number) => {
        const result: FetchPollResult = poller.poll(id);
        if (result.done) {
          try {
            deps.diagnostics?.record("fetch:done", {
              status: result.status,
              error: result.error,
              chunksThisPoll: result.chunks.length,
            });
          } catch {
            // A diagnostics failure must not poison an in-flight request.
          }
        }
        return result;
      },
      fetch_dispose: (id: number) => poller.dispose(id),
      // host.preview: setHtml (preview_refresh) + the async postMessage RPC
      // bridge (preview_query/click/fill/eval/screenshot). Mirrors the
      // fetch start/poll/dispose shape so the Fennel tools yield between
      // polls (docs/bindings/preview.md).
      preview_set_html: (html: unknown) => deps.preview.setHtml(String(html)),
      preview_rpc_start: (req: unknown) =>
        deps.preview.rpcStart(req as never),
      preview_rpc_poll: (id: number) => deps.preview.rpcPoll(id),
      preview_rpc_dispose: (id: number) => deps.preview.rpcDispose(id),
    },
  });

  let pump: Awaited<ReturnType<FenRuntime["createCoroutinePump"]>>;
  try {
    await installFetchBackend(rt, deps.fetchBackendSource);

    rt.lua.global.set("__demo_opts", {
      cwd: opts.cwd ?? "/workspace",
      provider,
      model: opts.model,
    });

    pump = await rt.createCoroutinePump(
      `function() return (require "fen_web.web.boot").run(__demo_opts) end`,
    );
  } catch (err) {
    // The coroutine pump only creates the Lua coroutine here; it does not run
    // fen_web.web.boot until the first pump(). This covers pre-pump setup
    // failures, chiefly installFetchBackend; body failures arrive in step().
    try {
      await deps.flush?.();
    } catch (flushErr) {
      console.error("fen-web demo: fatal-error flush failed", flushErr);
    }
    try {
      rt.close();
    } catch (closeErr) {
      console.error("fen-web demo: failed to close after boot error", closeErr);
    }
    try {
      await deps.dispose?.();
    } catch (disposeErr) {
      console.error("fen-web demo: failed to dispose after boot error", disposeErr);
    }
    try {
      deps.diagnostics?.recordError(err);
    } catch {
      // Diagnostics are best effort and must not replace the original boot error.
    }
    try {
      await deps.onFatal?.(err);
    } catch (callbackErr) {
      console.error("fen-web demo: fatal callback failed", callbackErr);
    }
    throw err;
  }

  const schedule =
    deps.schedule ??
    (typeof requestAnimationFrame === "function"
      ? (fn: () => void) => requestAnimationFrame(fn)
      : (fn: () => void) => setTimeout(fn, 16));

  let closed = false;
  let stopResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      try {
        rt.close();
      } catch (closeErr) {
        console.error("fen-web demo: failed to close runtime", closeErr);
      }
      try {
        await deps.dispose?.();
      } catch (disposeErr) {
        // Resource disposal is best-effort and must not hide the original
        // fatal error or leave stop() waiting forever.
        console.error("fen-web demo: failed to dispose host resources", disposeErr);
      }
    })().finally(() => stopResolve?.());
    return closePromise;
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
    try {
      const status = await pump.pump();
      if (status === "suspended") {
        if (!closed) schedule(() => void step());
        return;
      }
      await finish();
    } catch (err) {
      try {
        deps.diagnostics?.recordError(err);
      } catch {
        // Diagnostics are best effort and must not replace the run-loop error.
      }
      console.error("fen-web demo: run loop crashed", err);
      // The VM may have queued writes in the synchronous cache even though
      // the coroutine is poisoned. Drain those writes before closing it;
      // close() is deliberately last because the browser shims patch VM-wide
      // globals and have no uninstall operation.
      try {
        await deps.flush?.();
      } catch (flushErr) {
        console.error("fen-web demo: fatal-error flush failed", flushErr);
      }
      await finish();
      try {
        await deps.onFatal?.(err);
      } catch (callbackErr) {
        // Fatal reporting must not turn into an unhandled rejection of the
        // scheduler task (and the VM is already safely closed at this point).
        console.error("fen-web demo: fatal callback failed", callbackErr);
      }
    }
  };
  void step();

  return {
    flush: () => deps.flush?.() ?? Promise.resolve(),
    stop: () => {
      if (closed) return closePromise ?? Promise.resolve();
      return new Promise<void>((resolve) => {
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
      });
    },
    close: () => finish(),
  };
}
