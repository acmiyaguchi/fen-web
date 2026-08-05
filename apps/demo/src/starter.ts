/**
 * Browser-side bundler for the first-load starter project (fen-web#9).
 *
 * The starter files are real, reviewable source under `apps/demo/starter/`
 * (index.html + app.js + styles.css). The browser can't read the filesystem,
 * so — exactly like the Fennel source trees in `src/sources.ts` — they are
 * inlined at bundle time via Vite's `import.meta.glob(..., { query: "?raw" })`
 * and mapped to absolute vfs paths (`/index.html`, ...). `browserBoot.ts`
 * validates the bundle and seeds it into IndexedDB atomically on a genuine
 * first load via `IndexedDbKv.seedIfEmpty` (see `packages/bindings`'s
 * `starterSeed.ts`), before the VM ever snapshots the store.
 */

type RawGlob = Record<string, string>;

const starterGlob = import.meta.glob("../starter/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as RawGlob;

/**
 * Map bundled starter files to absolute vfs paths keyed for the seeder, e.g.
 * `../starter/index.html` -> `/index.html`. Nested files keep their relative
 * subpath so a future multi-directory starter needs no changes here.
 */
export function buildStarterFiles(): Record<string, string> {
  const marker = "/starter/";
  const files: Record<string, string> = {};
  for (const [path, src] of Object.entries(starterGlob)) {
    const idx = path.indexOf(marker);
    if (idx < 0) continue;
    const rel = path.slice(idx + marker.length);
    if (rel.length > 0) files[`/${rel}`] = src;
  }
  return files;
}
