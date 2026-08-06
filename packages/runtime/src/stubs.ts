/**
 * Built-in browser fulfillments for native seams that don't exist in a Lua
 * VM running in the browser. Installed into `package.preload` (preload always
 * wins over the custom searcher, so the native selector sources are never
 * consulted). Callers can override any entry by passing the same key in
 * `opts.preload`.
 */

/**
 * cjson: pure-Lua JSON, not a JS bridge. See vendor/cjson_stub.lua for the
 * full rationale (a JS `JSON.parse`/`JSON.stringify` bridge across the
 * wasmoon boundary produces non-table decode results that fail fen's
 * `(= (type value) :table)` gates, breaks `pairs()` iteration, and turns
 * a JSON `null` into a JS `null` that crashes wasmoon's promise-marshalling
 * `.then` probe on the first `"content":null` stream delta) and API
 * surface (`encode`, `decode`, `null`, `empty_array`, `array_mt`,
 * `decode_array_with_array_mt`).
 */
/**
 * fen.util.process has no OS process access in-VM, so its process methods
 * fail clearly (or use the harmless empty-pipe fallback above). The v0.17
 * clock seam is fulfilled separately below: `monotonic-ms` is wired to a real
 * wall clock (`performance.now` via `__fen_host.now_ms`, per fen-web#16
 * decision item 6 -- reload diagnostics need a real clock, not `os.clock`),
 * while `sleep-ms` is a cooperative no-op. A real setTimeout-backed async
 * sleep would be needed if a caller ever relies on elapsed delay rather than
 * treating sleep as a yield point.
 *
 * Field list mirrors fen.util.process's v0.17 export table exactly (see
 * fen/packages/util/src/fen/util/process/init.fnl): `read-pipe-coop`,
 * `read-pipe-close`, `start-captured`, `run-captured`, and `setenv!`.
 * Monotonic time and sleep moved to fen.util.clock in v0.17, so they are
 * fulfilled by CLOCK_STUB_LUA rather than being invented on this module.
 */
export const PROCESS_STUB_LUA = `
local function unsupported(name)
  return function()
    error("fen.util.process." .. name .. " is not supported in the browser VM (no OS process access)")
  end
end
return {
  ["run-captured"] = unsupported("run-captured"),
  ["start-captured"] = unsupported("start-captured"),
  ["read-pipe-close"] = function(_p, _yield) return "" end,
  ["read-pipe-coop"] = unsupported("read-pipe-coop"),
  ["setenv!"] = function(_k, _v) return nil end,
}
`;

/** v0.17 moved monotonic time/sleep out of fen.util.process into this seam. */
export const CLOCK_STUB_LUA = `
return {
  ["monotonic-ms"] = function() return __fen_host.now_ms() end,
  ["sleep-ms"] = function(_ms) return nil end,
}
`;

/**
 * Browser path/VFS fulfillment for fen.util.path.backend. The browser has no
 * POSIX filesystem to probe, while API-key lookup still needs the same
 * allowlisted kv namespace as fen-web's fs_kv shim.
 */
export const PATH_BACKEND_STUB_LUA = `
local function host()
  return rawget(_G, "__fen_host") or {}
end

local function kv_get(key)
  local kv = host().kv
  if kv ~= nil and type(kv.get) == "function" then
    return kv.get(key)
  end
  return nil
end

local function api_key_name(name)
  local s = tostring(name or "")
  return string.match(s, "^[A-Z][A-Z0-9_]*$") ~= nil and
    (string.match(s, "_KEY$") ~= nil or
     string.match(s, "_TOKEN$") ~= nil or
     string.match(s, "_SECRET$") ~= nil or
     string.match(s, "^KEY$") ~= nil)
end

return {
  getenv = function(name)
    local h = host()
    if type(h.path_getenv) == "function" then
      local value = h.path_getenv(name)
      if value ~= nil then return value end
    end
    if api_key_name(name) then
      return kv_get("env/apikey/" .. tostring(name))
    end
    return nil
  end,
  stat = function(_path) return nil end,
  ["list-dir"] = function(_dir) return {} end,
  ["pwd-physical"] = function(_dir) return "." end,
}
`;

/** Browser fulfillment for fen.core.storage.backend over the synchronous KV view. */
export const STORAGE_BACKEND_STUB_LUA = `
local function kv()
  local h = rawget(_G, "__fen_host") or {}
  local store = h.kv
  if store == nil or type(store.get) ~= "function" or
     type(store.put) ~= "function" then
    error("fen-web: fen.core.storage requires a synchronous __fen_host.kv")
  end
  return store
end

return {
  read = function(path)
    return kv().get(path)
  end,
  ["write!"] = function(path, content)
    kv().put(path, content)
  end,
}
`;

// Names always preloaded unless the caller overrides them via opts.preload.
// `cjson` is intentionally NOT eagerly loaded from disk here: it is only
// read when a caller omits it (Node), through the lazy dynamic import in
// createFenRuntime, so importing this module (and @fen-web/runtime) in a
// browser bundle never touches node:fs. Browser callers pass their own
// bundled `cjson` preload.
export const BUILTIN_PRELOAD_LUA: Record<string, string> = {
  "fen.util.process": PROCESS_STUB_LUA,
  "fen.util.clock.backend": CLOCK_STUB_LUA,
  "fen.util.path.backend": PATH_BACKEND_STUB_LUA,
  "fen.core.storage.backend": STORAGE_BACKEND_STUB_LUA,
};
