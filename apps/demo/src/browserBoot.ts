import {
  IndexedDbKv,
  SyncKvCache,
  WebHostDomApply,
  WebHostFetch,
  WebHostPreview,
} from "@fen-web/bindings";
import { bootDemo, type DemoBootOptions, type DemoSession } from "./boot.js";
import { buildDemoSources } from "./sources.js";
import { buildStarterFiles } from "./starter.js";

// Vendored VM sources bundled as raw text (the runtime's Node fs readers
// don't run in-page — see docs/runtime/boot.md's browser note). These
// Vite-only `?raw` imports live here, NOT in boot.ts, so boot.ts stays
// node-importable for src/bootTurn.test.ts.
import fennelSource from "../../../packages/runtime/vendor/fennel-1.6.0.lua?raw";
import cjsonStubSource from "../../../packages/runtime/vendor/cjson_stub.lua?raw";
import fetchBackendSource from "../../../packages/bindings/fnl/fen/util/http/backends/fetch.fnl?raw";

export type { DemoSession } from "./boot.js";

export interface BrowserBootOptions extends DemoBootOptions {
  /** IndexedDB database name (kept overridable for tests). */
  dbName?: string;
}

/**
 * Browser assembly of {@link bootDemo}: bundle-globbed VM sources, an
 * IndexedDB-backed synchronous kv snapshot, and the real DOM/fetch host
 * primitives. The API key is read from the same IndexedDB store the settings
 * form wrote it to (kv path `env/apikey/<VAR>`), so it never rides through a
 * JS global or a boot option — it is resolved in-VM via `os.getenv`.
 */
export async function bootDemoInBrowser(
  opts: BrowserBootOptions = {},
): Promise<DemoSession> {
  const kvBacking = new IndexedDbKv(opts.dbName ?? "fen-web-demo");
  // fen's kv-backed seams (sessions, fs_kv) call kv synchronously; mirror
  // the store into a synchronous cache at boot (see SyncKvCache). Loading
  // here also captures the current stored API key for in-VM resolution.
  const kv = await SyncKvCache.load(kvBacking);
  const dom = new WebHostDomApply();

  return bootDemo(opts, {
    sources: buildDemoSources(),
    starterFiles: buildStarterFiles(),
    fetchBackendSource,
    fennelSource,
    cjsonSource: cjsonStubSource,
    kv,
    dom,
    // The sandboxed preview iframe mounts under #fen-preview (index.html);
    // it renders the IndexedDB app tree and never gets allow-same-origin.
    preview: new WebHostPreview({ mountId: "fen-preview" }),
    fetch: new WebHostFetch(),
    flush: () => kv.flush(),
  });
}
