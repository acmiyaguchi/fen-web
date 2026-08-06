import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFenRuntime, loadFenTree } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fenRoot = path.resolve(here, "..", "..", "..", "fen", "packages");

function sources() {
  return loadFenTree([path.join(fenRoot, "core", "src"), path.join(fenRoot, "util", "src")]);
}

test("loadFenTree resolves fen.core.llm to llm/init.fnl (directory module)", () => {
  const map = sources();
  assert.ok(map.has("fen.core.llm"));
  assert.equal(map.get("fen.core.llm")!.lang, "fnl");
});

test("require fen.core.types works", async () => {
  const rt = await createFenRuntime({ sources: sources() });
  try {
    const mod = await rt.require("fen.core.types");
    assert.ok(mod);
  } finally {
    rt.close();
  }
});

test("require fen.core.agent works with browser seam fulfillments", async () => {
  const rt = await createFenRuntime({ sources: sources() });
  try {
    const mod = await rt.require("fen.core.agent");
    assert.ok(mod);
  } finally {
    rt.close();
  }
});

test("a compile error in a .fnl surfaces a readable fennel message, not bare 'module not found'", async () => {
  const map = sources();
  map.set("fen.web.broken", { lang: "fnl", src: "(this is not valid fennel (((" });
  const rt = await createFenRuntime({ sources: map });
  try {
    await assert.rejects(
      () => rt.require("fen.web.broken"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /fennel compile error/);
        assert.doesNotMatch(err.message, /^module 'fen\.web\.broken' not found/);
        return true;
      },
    );
  } finally {
    rt.close();
  }
});
