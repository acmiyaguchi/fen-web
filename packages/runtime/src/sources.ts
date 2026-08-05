import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface FenSource {
  lang: "fnl" | "lua";
  src: string;
}

/**
 * A source lookup: either a plain Map from dotted module name to source,
 * or a function performing the lookup (e.g. backed by host.kv in the
 * browser). `createFenRuntime`'s custom searcher calls this on every
 * `require` miss against `package.loaded`/`package.preload`.
 */
export type SourceLookup = Map<string, FenSource> | ((name: string) => FenSource | undefined);

export function resolveSource(lookup: SourceLookup, name: string): FenSource | undefined {
  return typeof lookup === "function" ? lookup(name) : lookup.get(name);
}

/**
 * Node-side helper: walks one or more directory trees (e.g. the fen
 * submodule's `packages/core/src` and `packages/util/src`) and builds a
 * module-name -> source map keyed the way Fennel/Lua `require` expects
 * (dots for path separators), handling `init.fnl`/`init.lua` directory
 * modules (e.g. `fen.core.llm` -> `llm/init.fnl`).
 *
 * Only used by tests / Node tooling; the browser feeds `opts.sources`
 * from host.kv instead.
 */
export function loadFenTree(dirs: string[]): Map<string, FenSource> {
  const map = new Map<string, FenSource>();
  for (const dir of dirs) {
    walk(dir, dir, map);
  }
  return map;
}

function walk(root: string, dir: string, map: Map<string, FenSource>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(root, full, map);
      continue;
    }
    const ext = path.extname(entry);
    if (ext !== ".fnl" && ext !== ".lua") continue;
    const lang = ext === ".fnl" ? "fnl" : "lua";
    const rel = path.relative(root, full); // e.g. fen/core/llm/init.fnl
    const withoutExt = rel.slice(0, -ext.length);
    const parts = withoutExt.split(path.sep);
    let modname: string;
    if (parts[parts.length - 1] === "init") {
      modname = parts.slice(0, -1).join(".");
    } else {
      modname = parts.join(".");
    }
    if (!modname) continue;
    map.set(modname, { lang, src: readFileSync(full, "utf8") });
  }
}
