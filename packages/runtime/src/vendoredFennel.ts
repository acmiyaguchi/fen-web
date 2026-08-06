import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Fennel version pinned by fen/Makefile (`FENNEL_VER`). Kept in lockstep. */
export const FENNEL_VERSION = "1.6.0";

// Resolved lazily inside the readers (not at module top level) so merely
// importing this module has no side effects; the browser build reaches this
// file only through the lazy `import()` in index.ts's Node-default path,
// which the browser never executes (it passes opts.fennelSource / a cjson
// preload). See docs/apps/web.md's bundler note.
function vendorPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/vendoredFennel.js -> ../vendor/<name>
  return path.join(here, "..", "vendor", name);
}

/**
 * Reads the vendored fennel-1.6.0.lua source from packages/runtime/vendor.
 * Node-only (uses fs). Browser builds should fetch/bundle the same file and
 * pass its contents as `opts.fennelSource` to `createFenRuntime`.
 */
export function loadVendoredFennelSource(): string {
  return readFileSync(vendorPath(`fennel-${FENNEL_VERSION}.lua`), "utf8");
}

/**
 * Reads the vendored pure-Lua cjson-compatible stub from
 * packages/runtime/vendor/cjson_stub.lua (see stubs.ts for why this is
 * pure Lua and not a JS bridge). Node-only; browser builds should
 * fetch/bundle the same file (or pass their own `cjson` entry in
 * `opts.preload` to override it entirely).
 */
export function loadVendoredCjsonStubSource(): string {
  return readFileSync(vendorPath("cjson_stub.lua"), "utf8");
}
