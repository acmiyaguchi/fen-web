import {
  IndexedDbKv,
  SyncKvCache,
  validateStarterFiles,
  WebHostDomApply,
  WebHostFetch,
  WebHostNotify,
  WebHostPreview,
} from "@fen-web/bindings";
import { bootDemo, type DemoBootOptions, type DemoSession } from "./boot.js";
import { buildDemoSources } from "./sources.js";
import { buildStarterFiles } from "./starter.js";
import type { DiagnosticsBuffer } from "./diagnostics.js";
import { requestStorageDurability } from "./storageDurability.js";

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
  /** Browser-side ring buffer for bus/fetch/fatal diagnostics. */
  diagnostics?: DiagnosticsBuffer;
  /** Called for asynchronous SyncKvCache write-back failures. */
  onWriteBackError?: (err: unknown) => void;
  /** Called after a fatal boot/run-loop error has been flushed and the VM closed. */
  onFatal?: (err: unknown) => void | Promise<void>;
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
  // Fire-and-forget: persist() may gate on a permission prompt in some
  // browsers, and boot must not stall behind a dialog. The probe records
  // its outcome into the stable diagnostics context whenever it settles.
  void requestStorageDurability(
    typeof navigator === "object" ? navigator.storage : undefined,
    opts.diagnostics,
  ).catch(() => undefined);
  const kvBacking = new IndexedDbKv(
    opts.dbName ?? "fen-web-demo",
    undefined,
    undefined,
    {
      onBlocked: (name) => {
        try {
          opts.diagnostics?.recordCollapsed("kv:open-blocked", { database: name });
        } catch {
          // Diagnostics are observational and must not affect the open.
        }
      },
    },
  );
  let preview: WebHostPreview | undefined;
  let handedOff = false;
  const dispose = async (): Promise<void> => {
    preview?.dispose();
    try {
      await kvBacking.close();
    } catch (err) {
      console.error("fen-web demo: failed to close IndexedDB", err);
    }
  };

  try {
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
  // fs_kv's patched os.getenv returns nil (including HOME/XDG_CONFIG_HOME),
  // so `(.. (or HOME "/") "/.config")` yields the double-slash path. Refreshed
  // on every boot so a token rotated by the CLI wins over a stale copy.
  if (import.meta.env.DEV) {
    const res = await fetch("/__fen/codex-auth").catch(() => undefined);
    if (res?.ok) {
      const authJson = await res.text();
      // The bridge response is the last JS-visible auth seam. Register both
      // OAuth token values before the blob is handed to the VM so diagnostics
      // can scrub them even when an auth/provider error echoes a token.
      try {
        const auth = JSON.parse(authJson) as Record<string, unknown>;
        const codex = auth["openai-codex"];
        if (codex && typeof codex === "object") {
          const record = codex as Record<string, unknown>;
          for (const key of ["access", "refresh", "access_token", "refresh_token"]) {
            const token = record[key];
            if (typeof token === "string") opts.diagnostics?.addSecret(token);
          }
        }
      } catch {
        // The VM will report malformed auth JSON; diagnostics must not alter
        // that behavior or make the seed seam throw a different error.
      }
      await kvBacking.put("//.config/fen/auth.json", authJson);
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
  const kv = await SyncKvCache.load(kvBacking, (err) => {
    try {
      opts.diagnostics?.recordCollapsed("kv:write-back-failed", err);
      void opts.diagnostics?.refreshStorageEstimate();
    } catch {
      // Diagnostics are best effort and must not replace the storage error.
    }
    try {
      opts.onWriteBackError?.(err);
    } catch (callbackErr) {
      // A page notice is observational; SyncKvCache.flush must still be able
      // to reject with the original write-back error.
      console.error("fen-web demo: write-back failure callback failed", callbackErr);
    }
  });
  const dom = new WebHostDomApply();
  preview = new WebHostPreview({ mountId: "fen-preview" });
  const notify = new WebHostNotify();

  const session = await bootDemo(opts, {
    sources: buildDemoSources(),
    fetchBackendSource,
    fennelSource,
    cjsonSource: cjsonStubSource,
    kv,
    dom,
    // The sandboxed preview iframe mounts under #fen-preview (index.html);
    // it renders the IndexedDB app tree and never gets allow-same-origin.
    preview: preview!,
    notify,
    fetch: new WebHostFetch(),
    flush: () => kv.flush(),
    dispose,
    diagnostics: opts.diagnostics,
    onFatal: opts.onFatal,
  });
  handedOff = true;
  return session;
  } finally {
    // Assembly failures happen before bootDemo owns the per-boot resources.
    // bootDemo also invokes this seam for pre-pump failures; both operations
    // are idempotent so the browser path stays leak-free in either case.
    if (!handedOff) await dispose();
  }
}
