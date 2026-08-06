import type { FenSource } from "@fen-web/runtime";

/**
 * Browser-side builder for the `createFenRuntime` source map. The Node
 * tests use `loadFenTree` (fs walk); the browser can't read the filesystem,
 * so the fen submodule + fen-web Fennel trees are inlined at bundle time via
 * Vite's `import.meta.glob(..., { query: "?raw", eager: true })` and mapped
 * to dotted `require` names here — the browser fulfillment of the
 * "sources from host.kv or the bundle" note in docs/runtime/boot.md.
 *
 * Path → module-name mapping mirrors `packages/runtime/src/sources.ts`'s
 * `loadFenTree`: strip the tree root prefix and the extension, collapse
 * `init.fnl` → the package name, and join path segments with dots.
 */

type RawGlob = Record<string, string>;

/** fen's own packages/* trees follow a directory==package-name layout. */
const coreGlob = import.meta.glob("../../../fen/packages/core/src/**/*.{fnl,lua}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;
const utilGlob = import.meta.glob("../../../fen/packages/util/src/**/*.{fnl,lua}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;

/**
 * fen's `fen.*` process-lifecycle package: the demo reuses its run_state,
 * turn_submit, turn_lifecycle, and session_lifecycle modules rather than
 * re-implementing the interactive turn/tick loop (see fen_web.web.boot).
 * Only the modules actually required load; the CLI entry (main.fnl) etc.
 * stay dormant in the source map.
 */
const fenGlob = import.meta.glob("../../../fen/packages/fen/src/**/*.{fnl,lua}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;

/** fen-web platform Fennel (fen_web.* shims, tools, sessions). */
const platformGlob = import.meta.glob("../../../packages/platform/fnl/**/*.fnl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;

/** The demo app's own Fennel (fen_web.web.*). */
const demoGlob = import.meta.glob("../fnl/**/*.fnl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;

/**
 * Provider extensions live in fen as a *flat* directory whose real module
 * names come from a rockspec, not the directory layout (see
 * packages/integration/src/turn.test.ts's buildSources for the same
 * treatment). Map them by hand under their real dotted names.
 */
const anthropicGlob = import.meta.glob(
  "../../../fen/extensions/adapters/providers/anthropic/*.fnl",
  { query: "?raw", import: "default", eager: true },
) as RawGlob;
const openaiGlob = import.meta.glob(
  "../../../fen/extensions/adapters/providers/openai/*.fnl",
  { query: "?raw", import: "default", eager: true },
) as RawGlob;
const providerSharedGlob = import.meta.glob(
  "../../../fen/extensions/adapters/providers/shared/*.fnl",
  { query: "?raw", import: "default", eager: true },
) as RawGlob;

function langOf(path: string): "fnl" | "lua" {
  return path.endsWith(".lua") ? "lua" : "fnl";
}

/** relative path under a tree root -> dotted module name (init collapse). */
function relToModule(rel: string): string {
  const withoutExt = rel.replace(/\.(fnl|lua)$/, "");
  const parts = withoutExt.split("/").filter((p) => p.length > 0);
  if (parts[parts.length - 1] === "init") parts.pop();
  return parts.join(".");
}

function addTree(map: Map<string, FenSource>, glob: RawGlob, rootMarker: string): void {
  for (const [path, src] of Object.entries(glob)) {
    const idx = path.indexOf(rootMarker);
    if (idx < 0) continue;
    const rel = path.slice(idx + rootMarker.length);
    const modname = relToModule(rel);
    if (modname) map.set(modname, { lang: langOf(path), src });
  }
}

/** flat provider dir -> `<baseModule>[.<file>]` (file `init` -> baseModule). */
function addFlatPackage(
  map: Map<string, FenSource>,
  glob: RawGlob,
  baseModule: string,
): void {
  for (const [path, src] of Object.entries(glob)) {
    const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.fnl$/, "");
    const modname = file === "init" ? baseModule : `${baseModule}.${file}`;
    map.set(modname, { lang: "fnl", src });
  }
}

/**
 * Build the full `createFenRuntime` source map: fen core + util, the flat
 * Anthropic provider (+ shared streaming/retry helpers), the fen-web
 * platform tree, and the demo app tree.
 */
export function buildDemoSources(): Map<string, FenSource> {
  const map = new Map<string, FenSource>();
  addTree(map, coreGlob, "fen/packages/core/src/");
  addTree(map, utilGlob, "fen/packages/util/src/");
  addTree(map, fenGlob, "fen/packages/fen/src/");
  addTree(map, platformGlob, "packages/platform/fnl/");
  addTree(map, demoGlob, "/fnl/");
  addFlatPackage(map, anthropicGlob, "fen.extensions.provider_anthropic");
  addFlatPackage(map, openaiGlob, "fen.extensions.provider_openai");
  addFlatPackage(map, providerSharedGlob, "fen.extensions.provider_shared");
  return map;
}
