// Browser stand-in for the Node built-ins that `@fen-web/runtime` imports
// for its Node-only helpers (loadFenTree / loadVendoredFennelSource /
// loadVendoredCjsonStubSource). The demo never calls those — it passes
// opts.fennelSource and a bundled `cjson` preload, and builds its source
// map from import.meta.glob (src/sources.ts) — but the runtime's dynamic
// `import("./vendoredFennel.js")` still pulls the module (and its `node:*`
// imports) into the build graph, so Rollup needs these specifiers to
// resolve. They throw if ever actually invoked, so a real accidental use
// fails loudly instead of silently misbehaving.
function unavailable(name: string): never {
  throw new Error(
    `@fen-web/web: node:${name} is not available in the browser; ` +
      "the runtime's Node-only vendor/source helpers must not run in-page",
  );
}

export function readFileSync(): never {
  return unavailable("fs.readFileSync");
}
export function readdirSync(): never {
  return unavailable("fs.readdirSync");
}
export function statSync(): never {
  return unavailable("fs.statSync");
}
export function fileURLToPath(): never {
  return unavailable("url.fileURLToPath");
}

// `import path from "node:path"` / `import fs from "node:fs"` default imports.
export default {
  dirname: () => unavailable("path.dirname"),
  join: () => unavailable("path.join"),
  relative: () => unavailable("path.relative"),
  extname: () => unavailable("path.extname"),
  sep: "/",
  readFileSync,
  readdirSync,
  statSync,
  fileURLToPath,
};
