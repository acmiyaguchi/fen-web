import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFenRuntime, FENNEL_VERSION } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fenMakefile = path.resolve(here, "..", "..", "..", "fen", "Makefile");

function readMakefileFennelVer(): string {
  const text = readFileSync(fenMakefile, "utf8");
  const m = text.match(/^FENNEL_VER\s*:=\s*(\S+)\s*$/m);
  if (!m) throw new Error(`could not find FENNEL_VER in ${fenMakefile}`);
  return m[1];
}

test("engine boots and fennel loads at the pinned version", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    assert.equal(rt.fennelVersion, FENNEL_VERSION);
  } finally {
    rt.close();
  }
});

test("FENNEL_VERSION matches fen/Makefile's FENNEL_VER pin (catches submodule bumps)", () => {
  assert.equal(FENNEL_VERSION, readMakefileFennelVer());
});

test("host table is installed as __fen_host before any require", async () => {
  const rt = await createFenRuntime({
    sources: new Map(),
    host: { ping: () => "pong" },
  });
  try {
    await rt.doString(`__ping_result = __fen_host.ping()`);
    const result = rt.lua.global.get("__ping_result");
    assert.equal(result, "pong");
  } finally {
    rt.close();
  }
});

test("built-in cjson stub: decode produces a genuine Lua table (not JS userdata)", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local cjson = require("cjson")
      local v = cjson.decode('{"a":1,"b":[1,2,3]}')
      __type = type(v)
      __a = v.a
    `);
    assert.equal(rt.lua.global.get("__type"), "table");
    assert.equal(rt.lua.global.get("__a"), 1);
  } finally {
    rt.close();
  }
});

test("built-in cjson stub: pairs() iterates a decoded object", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local cjson = require("cjson")
      local v = cjson.decode('{"a":1,"b":2,"c":3}')
      local sum = 0
      local count = 0
      for k, val in pairs(v) do
        sum = sum + val
        count = count + 1
      end
      __sum = sum
      __count = count
    `);
    assert.equal(rt.lua.global.get("__sum"), 6);
    assert.equal(rt.lua.global.get("__count"), 3);
  } finally {
    rt.close();
  }
});

test("built-in cjson stub: JSON null round-trips via cjson.null without crashing the VM", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local cjson = require("cjson")
      local v = cjson.decode('{"content":null}')
      __is_null = (v.content == cjson.null)
      __reencoded = cjson.encode(v)
    `);
    assert.equal(rt.lua.global.get("__is_null"), true);
    assert.equal(rt.lua.global.get("__reencoded"), '{"content":null}');
  } finally {
    rt.close();
  }
});

test("built-in cjson stub: [] and {} round-trip distinguishably via array_mt", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local cjson = require("cjson")
      cjson.decode_array_with_array_mt(true)
      local arr = cjson.decode("[]")
      local obj = cjson.decode("{}")
      __arr_reencoded = cjson.encode(arr)
      __obj_reencoded = cjson.encode(obj)
      __empty_array_reencoded = cjson.encode(cjson.empty_array)
    `);
    assert.equal(rt.lua.global.get("__arr_reencoded"), "[]");
    assert.equal(rt.lua.global.get("__obj_reencoded"), "{}");
    assert.equal(rt.lua.global.get("__empty_array_reencoded"), "[]");
  } finally {
    rt.close();
  }
});

test("built-in cjson stub: sparse arrays encode with null padding instead of degrading to an object", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local cjson = require("cjson")
      local t = {1, 2, nil, 4}
      __encoded = cjson.encode(t)
    `);
    assert.equal(rt.lua.global.get("__encoded"), "[1,2,null,4]");
  } finally {
    rt.close();
  }
});

test("built-in fen.util.process stub exposes monotonic-ms via host now_ms", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local process = require("fen.util.process")
      __t = process["monotonic-ms"]()
    `);
    const t = rt.lua.global.get("__t");
    assert.equal(typeof t, "number");
    assert.ok(t >= 0);
  } finally {
    rt.close();
  }
});

test("fen.util.process['run-captured'] errors with a clear not-supported message (a real exported field, not a phantom 'run')", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await rt.doString(`
      local process = require("fen.util.process")
      local ok, err = pcall(process["run-captured"])
      __ok = ok
      __err = tostring(err)
    `);
    assert.equal(rt.lua.global.get("__ok"), false);
    assert.match(String(rt.lua.global.get("__err")), /not supported in the browser VM/);
  } finally {
    rt.close();
  }
});

test("missing-module require error names the fen-web source map, not just /usr/local lua paths", async () => {
  const rt = await createFenRuntime({ sources: new Map() });
  try {
    await assert.rejects(
      () => rt.require("fen.web.does.not.exist"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /fen-web: not in fen-web source map: fen\.web\.does\.not\.exist/);
        return true;
      },
    );
  } finally {
    rt.close();
  }
});
