import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Fennel version pinned by fen/Makefile (`FENNEL_VER`). Kept in lockstep. */
export const FENNEL_VERSION = "1.6.0";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads the vendored fennel-1.6.0.lua source from packages/runtime/vendor.
 * Node-only (uses fs). Browser builds should fetch/bundle the same file
 * and pass its contents as `opts.fennelSource` to `createFenRuntime`.
 */
export function loadVendoredFennelSource(): string {
  // dist/vendoredFennel.js -> ../vendor/fennel-1.6.0.lua
  const vendorPath = path.join(here, "..", "vendor", `fennel-${FENNEL_VERSION}.lua`);
  return readFileSync(vendorPath, "utf8");
}

/**
 * Reads the vendored pure-Lua cjson-compatible stub from
 * packages/runtime/vendor/cjson_stub.lua (see stubs.ts for why this is
 * pure Lua and not a JS bridge). Node-only; browser builds should
 * fetch/bundle the same file (or pass their own `cjson` entry in
 * `opts.preload` to override it entirely).
 */
export function loadVendoredCjsonStubSource(): string {
  const vendorPath = path.join(here, "..", "vendor", "cjson_stub.lua");
  return readFileSync(vendorPath, "utf8");
}
