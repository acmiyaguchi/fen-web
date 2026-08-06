import type { HostKv } from "./types.js";

// First-load starter-project seeding (fen-web#9), moved to the JS/durable
// layer after the adversarial review of PR #27.
//
// The original design seeded from inside the Lua VM against SyncKvCache's
// boot-time snapshot. That is neither race-safe nor durable: two tabs can each
// load an empty snapshot and both seed (clobbering user work), and the VM's
// writes only hit the synchronous cache — a page close/quota/abort could
// persist only some starter files, and the next boot's non-empty check would
// then permanently skip repair, leaving a broken half-seed. The recheck of
// *persistent* state and an atomic, all-or-nothing commit both require async
// IndexedDB access the Lua coroutine cannot await, so seeding belongs here.
//
// The starter files themselves are still real, reviewable source under
// apps/web/starter/ and WHICH files ship is still application choice
// (buildStarterFiles). This module only owns the durable seed *mechanism*:
// validate the bundle, and commit it once, atomically, only when the store
// holds no user work — gated on a seed-complete marker written last within the
// same commit so a partial write is retried, never mistaken for a finished
// seed.

/** Key marking a completed starter seed. Lives OUTSIDE the "fs:" vfs keyspace
 * (and the "session:"/"env/" keyspaces) so it is never walked as a file, but
 * is checked as part of the emptiness/repair gate: its presence means a prior
 * seed committed in full, so we never seed (or repair) again. */
export const SEED_MARKER_KEY = "seed:starter-complete";

/** kv key prefix the virtual filesystem stores files under (mirrors
 * fen_web.tools.vfs's KEY-PREFIX). A file at vfs path "/index.html" lives at
 * kv key "fs:/index.html". */
export const FS_PREFIX = "fs:";

/** Map an absolute vfs path to its backing kv key. */
export function fsKeyFor(path: string): string {
  return FS_PREFIX + path;
}

/**
 * Validate a decoded starter bundle: a non-empty map of absolute vfs paths to
 * string contents. The starter bundle is REQUIRED for this feature, so a
 * malformed/missing/empty bundle is a hard boot error with a clear message
 * rather than a silent "seeded zero files, success" (the review's LOW finding:
 * bad JSON decoding to `{}` used to pass).
 *
 * Returns the validated map (narrowed to `Record<string, string>`).
 */
export function validateStarterFiles(files: unknown): Record<string, string> {
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(
      "fen-web starter seed: starter bundle must be a { \"/path\" -> contents } " +
        `object, got ${Array.isArray(files) ? "an array" : typeof files}`,
    );
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      "fen-web starter seed: starter bundle is empty — the curated starter " +
        "project is required for this feature (expected apps/web/starter/ " +
        "index.html + app.js + styles.css). Check the bundler glob / staging.",
    );
  }
  const out: Record<string, string> = {};
  for (const [path, contents] of entries) {
    if (typeof path !== "string" || path.length === 0 || path[0] !== "/") {
      throw new Error(
        `fen-web starter seed: invalid starter path ${JSON.stringify(path)} — ` +
          'expected an absolute vfs path beginning with "/"',
      );
    }
    if (typeof contents !== "string") {
      throw new Error(
        `fen-web starter seed: starter file ${JSON.stringify(path)} has ` +
          `non-string contents (${typeof contents})`,
      );
    }
    out[path] = contents;
  }
  return out;
}

/**
 * Generic, best-effort seed over the async {@link HostKv} interface, for
 * stores without native multi-key transactions (MemoryKv, test doubles).
 *
 * It rechecks the *durable* store immediately before committing (marker first,
 * then any "fs:" file) and writes the seed-complete marker LAST, so a partial
 * failure leaves no marker and the next boot retries. It is NOT atomic — a
 * store that can abort mid-write can still leave a partial seed — so the real
 * IndexedDB path uses {@link IndexedDbKv.seedIfEmpty}'s single-transaction
 * override instead. Returns true when it wrote the starter files.
 */
export async function seedIfEmptyKv(
  kv: HostKv,
  files: Record<string, string>,
  markerKey: string = SEED_MARKER_KEY,
): Promise<boolean> {
  const valid = validateStarterFiles(files);
  // Recheck persistent state at commit time (not a stale snapshot): a prior
  // completed seed leaves the marker; any existing file is user (or prior
  // seed) content we must never clobber.
  if ((await kv.get(markerKey)) !== undefined) return false;
  if ((await kv.list(FS_PREFIX)).length > 0) return false;
  for (const [path, contents] of Object.entries(valid)) {
    await kv.put(fsKeyFor(path), contents);
  }
  // Marker written last: it is the durable "seed finished in full" signal the
  // gate above checks, so an interrupted seed is retried, not mistaken for done.
  await kv.put(markerKey, new Date().toISOString());
  return true;
}
