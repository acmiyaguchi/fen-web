import {
  IndexedDbKv,
  SyncKvCache,
  validateStarterFiles,
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
  // First-load starter seed (fen-web#9): atomically + durably seed the curated
  // starter project into IndexedDB BEFORE snapshotting, so the synchronous
  // cache only ever sees a consistent, fully-seeded (or fully-untouched) vfs.
  // seedIfEmpty is one conditional IndexedDB transaction — race-safe across
  // tabs, all-or-nothing on failure, gated on a seed-complete marker — so a
  // returning user's work is never clobbered and an interrupted seed is
  // retried rather than left permanently half-written. validateStarterFiles
  // fails boot loudly if the bundle is missing/malformed (it is required).
  await kvBacking.seedIfEmpty(validateStarterFiles(buildStarterFiles()));
  // Dev-only Codex credential seed: the Vite dev server bridges the local
  // fen CLI's ~/.config/fen/auth.json at /__fen/codex-auth (vite.config.ts).
  // Seed it into the exact kv path openai_codex_keychain computes in-VM —
  // the fs_kv getenv allowlist returns nil for HOME/XDG_CONFIG_HOME, so
  // `(.. (or HOME "/") "/.config")` yields the double-slash path. Refreshed
  // on every boot so a token rotated by the CLI wins over a stale copy.
  if (import.meta.env.DEV) {
    const res = await fetch("/__fen/codex-auth").catch(() => undefined);
    if (res?.ok) {
      await kvBacking.put("//.config/fen/auth.json", await res.text());
    } else if (opts.provider === "openai-codex") {
      // Fail here with the real reason instead of letting the VM boot and
      // report a generic "no credentials in auth.json" later. 403 means a
      // non-loopback client (the bridge is localhost-only by design).
      throw new Error(
        res?.status === 403
          ? "openai-codex needs the page opened via localhost or a Tailscale " +
            "address — the dev server only hands OAuth credentials to " +
            "loopback/tailnet clients"
          : "openai-codex needs local Codex credentials — run `fen --login openai-codex` first",
      );
    }
    // Bridge missing/empty with anthropic selected: nothing to seed, fine.
  }
  // fen's kv-backed seams (sessions, fs_kv) call kv synchronously; mirror
  // the store into a synchronous cache at boot (see SyncKvCache). Loading
  // here also captures the current stored API key for in-VM resolution.
  const kv = await SyncKvCache.load(kvBacking);
  const dom = new WebHostDomApply();

  return bootDemo(opts, {
    sources: buildDemoSources(),
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
