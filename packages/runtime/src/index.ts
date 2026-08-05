import { LuaFactory, type LuaEngine } from "wasmoon";
import { FENNEL_VERSION, loadVendoredFennelSource } from "./vendoredFennel.js";
import { resolveSource, type SourceLookup, type FenSource } from "./sources.js";
import { BUILTIN_PRELOAD_LUA } from "./stubs.js";

export { FENNEL_VERSION, loadVendoredFennelSource } from "./vendoredFennel.js";
export { loadFenTree, resolveSource } from "./sources.js";
export type { SourceLookup, FenSource } from "./sources.js";

/**
 * A preload entry, installed into Lua's `package.preload` before any
 * `require` runs (so it wins over the custom searcher). This is the seam
 * bindings' fetch backend and fen-web#15's shims use to inject real
 * implementations for names the custom searcher would otherwise resolve
 * from `opts.sources` (or that don't exist as fen source at all, like
 * `cjson`).
 *
 * - `string`: Lua source. Loaded and executed once; its return value
 *   becomes the module's value (same contract as a normal Lua module).
 * - `function`: a JS factory called with the booted `FenRuntime`. Its
 *   return value is marshalled into Lua and becomes the module's value.
 *   Use this when the module needs to close over live JS state (e.g. a
 *   binding's internal queues) rather than pure Lua source.
 */
export type PreloadEntry = string | ((rt: FenRuntime) => unknown | Promise<unknown>);

export interface FenRuntimeOptions {
  /** Module-name -> {lang, src} lookup for the custom package.searchers entry. */
  sources: SourceLookup;
  /**
   * Exposed to the VM as the global `__fen_host` before any require runs.
   * Merged over the runtime's default host helpers (`now_ms`, used by the
   * built-in fen.util.process stub) -- caller-supplied keys win.
   */
  host?: Record<string, unknown>;
  /** Extra/overriding package.preload entries, merged over the built-in cjson/fen.util.process stubs (caller wins on key collision). */
  preload?: Record<string, PreloadEntry>;
  /** Vendored fennel-1.6.0.lua source. Defaults to reading packages/runtime/vendor (Node only). */
  fennelSource?: string;
}

export interface FenRuntime {
  lua: LuaEngine;
  /** Fennel version string reported by the in-VM compiler (must be "1.6.0"). */
  fennelVersion: string;
  /** `require(modname)` in the VM; resolves to the module's marshalled value or rejects with a readable Lua/Fennel error message. */
  require(modname: string): Promise<unknown>;
  /** Runs a Lua chunk in the VM (thin wrapper over lua.doString for convenience/tests). */
  doString(code: string): Promise<unknown>;
  /**
   * Clears `package.loaded[modname]` so the next `require` re-resolves
   * (recompiling `.fnl` through the custom searcher, or re-running the
   * preload factory) instead of returning the cached module table. This
   * is the primitive `/reload` (fen-web#16 decision item 3/4) builds on:
   * single-file reload = uncache the changed leaf + the entry point,
   * leave everything else cached (~300ms per the fen-web#16 spike);
   * full-tree reload = uncache every pulled module (~1.5s). This helper
   * only does the uncache half -- tracking *which* modules were pulled
   * through the searcher (for full-tree reload, or to know what to
   * re-walk) is `/reload`'s job, not this runtime's.
   */
  uncache(modname: string): Promise<void>;
  /**
   * Builds a Lua coroutine from `fnSource` (Lua source text for a
   * zero-argument function expression, e.g. `"function() ... end"`) and
   * returns a pump handle to drive it one resume at a time. This is the
   * promoted, reusable form of the pattern the coroutine-bridge spike
   * (coroutine.test.ts) hand-rolled: interactive turn-driving (streaming
   * fetch chunks, agent turns) resumes a coroutine from JS on each async
   * event via a Lua-side pump function, so the yield always happens from
   * plain Lua code and never crosses a C-call boundary. See
   * fen/packages/util/tests/http_native_coop_test.fnl for the contract
   * this mirrors (`opts.yield` = `coroutine.yield`).
   */
  createCoroutinePump(fnSource: string): Promise<CoroutinePump>;
  close(): void;
}

/**
 * Handle returned by `FenRuntime.createCoroutinePump`. `pump()` resumes
 * the underlying coroutine exactly once per call; callers decide when to
 * call it next (e.g. after a `setTimeout` tick or a fetch-stream chunk
 * arrives). `pump()` throws (rather than swallowing) if
 * `coroutine.resume` itself errored, so a real bug never silently reads
 * as "still suspended".
 */
export interface CoroutinePump {
  /** Resumes the coroutine once; returns its Lua `coroutine.status` after the resume ("suspended" | "dead"). */
  pump(): Promise<string>;
  /** Once status is "dead": the coroutine function's return value, marshalled to JS. Rejects/returns undefined before that. */
  result(): Promise<unknown>;
}

function defaultHost(): Record<string, unknown> {
  return {
    now_ms: () => performance.now(),
  };
}

let preloadCounter = 0;
let pumpCounter = 0;

/**
 * Reentrancy note: `require`, `installPreload`, `uncache`, and
 * `createCoroutinePump` all stage arguments through shared, fixed-name
 * Lua globals (`__req_mod`, `__preload_name`, `__uncache_mod`, ...)
 * before running a `doString` that consumes them. That's safe under
 * `await`-sequenced usage (the only pattern this runtime or its tests
 * use) but is NOT safe if a caller fires multiple `rt.require(...)`
 * calls concurrently without awaiting each one -- the second call's
 * `lua.global.set` can clobber the first's staged argument before its
 * `doString` reads it. Always `await` these calls before starting the
 * next one on the same `FenRuntime`.
 */
async function installPreload(
  lua: LuaEngine,
  rt: FenRuntime,
  name: string,
  entry: PreloadEntry,
): Promise<void> {
  lua.global.set("__preload_name", name);
  if (typeof entry === "string") {
    lua.global.set("__preload_src", entry);
    // Use locals, not the (soon-overwritten) globals, so each preload's
    // closure captures its own source/name instead of whatever the last
    // installPreload() call left in __preload_src/__preload_name.
    await lua.doString(`
      do
        local src = __preload_src
        local pname = __preload_name
        local chunk, err = load(src, "@preload:" .. pname, "t")
        if not chunk then error("fen-web: preload load error for " .. pname .. ": " .. tostring(err)) end
        package.preload[pname] = chunk
      end
    `);
  } else {
    const value = await entry(rt);
    const key = `__preload_val_${preloadCounter++}`;
    lua.global.set(key, value);
    lua.global.set("__preload_key", key);
    await lua.doString(`
      local v = _G[__preload_key]
      package.preload[__preload_name] = function() return v end
    `);
  }
}

async function createCoroutinePump(lua: LuaEngine, fnSource: string): Promise<CoroutinePump> {
  const id = pumpCounter++;
  const coVar = `__fen_pump_co_${id}`;
  const pumpFnVar = `__fen_pump_fn_${id}`;
  const resultVar = `__fen_pump_result_${id}`;

  lua.global.set("__fen_pump_src", fnSource);
  lua.global.set("__fen_pump_var_prefix", `__fen_pump_${id}`);
  await lua.doString(`
    do
      local chunk = assert(load("return " .. __fen_pump_src, "@coroutine-pump"))
      local fn = chunk()
      ${coVar} = coroutine.create(fn)
      function ${pumpFnVar}()
        local ok, ret = coroutine.resume(${coVar})
        if not ok then
          error(tostring(ret))
        end
        if coroutine.status(${coVar}) == "dead" then
          ${resultVar} = ret
        end
        return coroutine.status(${coVar})
      end
    end
  `);

  return {
    async pump() {
      await lua.doString(`__fen_pump_status_tmp = ${pumpFnVar}()`);
      return String(lua.global.get("__fen_pump_status_tmp"));
    },
    async result() {
      return lua.global.get(resultVar);
    },
  };
}

/**
 * Boots a wasmoon (Lua 5.4) VM, boots the vendored Fennel 1.6.0 compiler
 * inside it, installs the __fen_host global, built-in cjson/fen.util.process
 * stubs plus any caller preloads, and installs a custom package.searchers
 * entry resolving from `opts.sources` per fen-web#16's decision (hybrid:
 * pinned core precompiled at bundle time is a later optimization -- this
 * runtime always compiles-on-require through the in-VM Fennel compiler,
 * which is what the app/user-extension tree and this package's tests use).
 */
export async function createFenRuntime(opts: FenRuntimeOptions): Promise<FenRuntime> {
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  const host = { ...defaultHost(), ...(opts.host ?? {}) };
  lua.global.set("__fen_host", host);

  const fennelSource = opts.fennelSource ?? loadVendoredFennelSource();
  lua.global.set("__fennel_src", fennelSource);
  await lua.doString(`
    local chunk = assert(load(__fennel_src, "@fennel.lua"))
    fennel = chunk()
    package.preload["fennel"] = function() return fennel end
  `);

  await lua.doString(`__fennel_version = fennel.version`);
  const fennelVersion = String(lua.global.get("__fennel_version"));

  const rt: FenRuntime = {
    lua,
    fennelVersion,
    async require(modname: string) {
      lua.global.set("__req_mod", modname);
      await lua.doString(`
        local ok, result = pcall(require, __req_mod)
        __req_ok = ok
        if ok then
          __req_result = result
          __req_err = nil
        else
          __req_result = nil
          __req_err = tostring(result)
        end
      `);
      const ok = lua.global.get("__req_ok");
      if (!ok) {
        const err = lua.global.get("__req_err");
        throw new Error(String(err));
      }
      return lua.global.get("__req_result");
    },
    doString(code: string) {
      return lua.doString(code);
    },
    async uncache(modname: string) {
      lua.global.set("__uncache_mod", modname);
      await lua.doString(`package.loaded[__uncache_mod] = nil`);
    },
    createCoroutinePump(fnSource: string) {
      return createCoroutinePump(lua, fnSource);
    },
    close() {
      lua.global.close();
    },
  };

  // Built-in stubs first, caller preloads win on key collision.
  const preloads: Record<string, PreloadEntry> = { ...BUILTIN_PRELOAD_LUA, ...(opts.preload ?? {}) };
  for (const [name, entry] of Object.entries(preloads)) {
    await installPreload(lua, rt, name, entry);
  }

  // Custom searcher: resolves modname -> {lang, src} via opts.sources,
  // compiles .fnl with the in-VM fennel, loads the result. Inserted at
  // index 2 (after the preload searcher, before the normal path
  // searchers) so preloads always win and this only fires on a miss.
  // On a Fennel compile error, error() with the fennel message rather
  // than returning nil, so `require` surfaces a readable diagnostic
  // instead of a bare "module not found" (fen-web#16 review note). On a
  // plain miss (not in opts.sources at all), still return nil (so later
  // searchers/preloads get a chance) but pair it with an explanatory
  // second return value -- Lua's `require` concatenates every failed
  // searcher's message into the final error, and without this the
  // browser-visible error is just a chain of "no field
  // package.preload['x']" / "no file '/usr/local/share/lua/...'" entries
  // that mean nothing in-VM (there is no filesystem). This searcher's
  // line names the actual lookup that was consulted.
  lua.global.set("__fen_resolve_source", (modname: string) => {
    const found = resolveSource(opts.sources, modname);
    if (!found) return undefined;
    return { src: found.src, lang: found.lang };
  });
  await lua.doString(`
    table.insert(package.searchers, 2, function(modname)
      local found = __fen_resolve_source(modname)
      if not found then
        -- Lua's require loop (findloader in lauxlib) treats a single
        -- string return as the "could not find it here" message for
        -- this searcher (NOT a second nil,msg return value -- a bare
        -- \`return nil\` here would silently vanish from the aggregated
        -- error). Returning it lets require's error listing name the
        -- actual lookup consulted, instead of only the /usr/local lua
        -- path searchers that mean nothing in-VM.
        return "fen-web: not in fen-web source map: " .. modname
      end
      local src, lang = found.src, found.lang
      if lang == "lua" then
        local chunk, err = load(src, "@" .. modname, "t")
        if not chunk then
          error("fen-web: lua load error for " .. modname .. ": " .. tostring(err))
        end
        return chunk, modname
      else
        local ok, compiled = pcall(fennel.compileString, src, {filename = modname, ["module-name"] = modname})
        if not ok then
          error("fen-web: fennel compile error for " .. modname .. ": " .. tostring(compiled))
        end
        local chunk, err = load(compiled, "@" .. modname, "t")
        if not chunk then
          error("fen-web: lua load error for " .. modname .. ": " .. tostring(err))
        end
        return chunk, modname
      end
    end)
  `);

  return rt;
}
