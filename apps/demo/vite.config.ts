import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const nodeStub = path.resolve(here, "src", "nodeBuiltinStub.ts");

// The demo bundles the fen submodule + fen-web Fennel trees as raw text via
// import.meta.glob (src/sources.ts), so the dev server must be allowed to
// read outside apps/demo. `@fen-web/runtime` also statically/dynamically
// references Node built-ins for its Node-only vendor readers, which the demo
// never runs; alias them to a throwing browser stub so Rollup can resolve
// them (see src/nodeBuiltinStub.ts).
export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "node:fs": nodeStub,
      "node:url": nodeStub,
      "node:path": nodeStub,
    },
  },
  server: {
    fs: { allow: [repoRoot] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
