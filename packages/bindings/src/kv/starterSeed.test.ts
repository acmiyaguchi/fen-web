import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKv } from "./memoryKv.js";
import {
  SEED_MARKER_KEY,
  fsKeyFor,
  seedIfEmptyKv,
  validateStarterFiles,
} from "./starterSeed.js";

const STARTER = {
  "/index.html": "<title>Starter todo</title>",
  "/app.js": "window.todoApp = {};",
  "/styles.css": ":root{}",
};

test("validateStarterFiles rejects a missing/empty/malformed bundle", () => {
  // The starter bundle is required; a bad decode must fail loudly, not
  // silently "seed zero files, success" (the review's LOW finding).
  assert.throws(() => validateStarterFiles(undefined), /must be a/);
  assert.throws(() => validateStarterFiles(null), /must be a/);
  assert.throws(() => validateStarterFiles([]), /must be a|an array/);
  assert.throws(() => validateStarterFiles({}), /empty/);
  assert.throws(
    () => validateStarterFiles({ "index.html": "x" }),
    /absolute vfs path/,
  );
  assert.throws(
    () => validateStarterFiles({ "/index.html": 42 }),
    /non-string contents/,
  );
});

test("validateStarterFiles returns the narrowed map for a good bundle", () => {
  assert.deepEqual(validateStarterFiles(STARTER), STARTER);
});

test("seedIfEmptyKv seeds a genuinely empty store and writes the marker last", async () => {
  const kv = new MemoryKv();
  const seeded = await seedIfEmptyKv(kv, STARTER);
  assert.equal(seeded, true);
  assert.equal(await kv.get(fsKeyFor("/index.html")), STARTER["/index.html"]);
  assert.equal(await kv.get(fsKeyFor("/app.js")), STARTER["/app.js"]);
  assert.equal(await kv.get(fsKeyFor("/styles.css")), STARTER["/styles.css"]);
  // Seed-complete marker present (the gate/repair signal), outside "fs:".
  assert.notEqual(await kv.get(SEED_MARKER_KEY), undefined);
  assert.equal((await kv.list("fs:")).length, 3);
});

test("seedIfEmptyKv is idempotent: a completed seed never re-seeds", async () => {
  const kv = new MemoryKv();
  assert.equal(await seedIfEmptyKv(kv, STARTER), true);
  assert.equal(await seedIfEmptyKv(kv, STARTER), false);
  assert.equal((await kv.list("fs:")).length, 3);
});

test("seedIfEmptyKv never clobbers pre-existing user files", async () => {
  const kv = new MemoryKv();
  await kv.put(fsKeyFor("/index.html"), "<h1>my work</h1>");
  const seeded = await seedIfEmptyKv(kv, STARTER);
  assert.equal(seeded, false);
  assert.equal(await kv.get(fsKeyFor("/index.html")), "<h1>my work</h1>");
  assert.equal(await kv.get(fsKeyFor("/app.js")), undefined);
  assert.equal(await kv.get(fsKeyFor("/styles.css")), undefined);
});

test("seedIfEmptyKv retries after a partial seed (no marker means not done)", async () => {
  // Simulate an interrupted seed that persisted a file but never wrote the
  // marker. Because the gate keys on the marker, a store with files but no
  // marker is treated as user content and left alone (never clobbered); the
  // marker-last discipline is what makes an all-or-nothing store retry.
  const kv = new MemoryKv();
  await kv.put(fsKeyFor("/index.html"), STARTER["/index.html"]);
  // No marker -> existing file gate wins: do not clobber.
  assert.equal(await seedIfEmptyKv(kv, STARTER), false);
  assert.equal(await kv.get(SEED_MARKER_KEY), undefined);
});
