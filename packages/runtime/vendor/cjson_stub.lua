-- Pure-Lua cjson-compatible module for fen-web's runtime.
--
-- Original design bridged decode to JS `JSON.parse` via `__fen_host`, but
-- that's wrong on every axis fen's callers actually rely on
-- (fen/packages/util/src/fen/util/json.fnl, consumed by
-- fen.core.settings / fen.core.llm.models):
--
--  - `JSON.parse` results cross into Lua as wasmoon proxy/userdata, not
--    genuine Lua tables, so `(= (type value) :table)` gates (settings.fnl:42,
--    the config-dir-not-a-table guard) and `pairs()` iteration both break.
--  - JSON `null` marshals as JS `null`, which is not just semantically
--    wrong (fen expects a `cjson.null` sentinel table so `null` survives a
--    decode -> mutate -> encode round trip distinguishably from "key
--    absent") but is actively dangerous: wasmoon's promise-marshalling
--    path (`PromiseTypeExtension`) probes returned values with `.then`,
--    and reading `.then` off JS `null` is a hard TypeError that would
--    detonate on the very first `"content":null` delta in an OpenAI/
--    Anthropic stream.
--  - cjson's real API includes `null`, `empty_array` (a sentinel that
--    forces `[]` instead of `{}` for an empty table -- OpenAI Responses
--    `content[].annotations` needs this) and `array_mt`/
--    `decode_array_with_array_mt` (lets `[]` and `{}` round-trip
--    distinguishably); none of that exists on the far side of a JS bridge.
--
-- Doing JSON entirely in Lua-land sidesteps the JS<->Lua boundary (and its
-- marshalling semantics) altogether, which is the simplest correct fix.
-- This is a small hand-rolled parser/serializer (not vendored from
-- rxi/json.lua) sized to cjson's API surface as fen actually uses it:
-- encode, decode, null, empty_array, array_mt, decode_array_with_array_mt.
-- It does not aim for full cjson parity (no encode_max_depth/
-- decode_max_depth config, no encode_number_precision) -- only what
-- fen/packages/{core,util} touch.

local M = {}

-- Sentinels -----------------------------------------------------------------

M.null = setmetatable({}, { __tostring = function() return "null" end })

local array_mt = {}
M.array_mt = array_mt

-- Always encodes as "[]", identity-checked (not via array_mt) since it
-- must force array shape even when empty.
M.empty_array = setmetatable({}, { __tostring = function() return "[]" end })

local decode_array_mt_enabled = false
function M.decode_array_with_array_mt(v)
  if v == nil then return decode_array_mt_enabled end
  decode_array_mt_enabled = not not v
  return decode_array_mt_enabled
end

-- Encoding --------------------------------------------------------------------

local escape_map = {
  ["\\"] = "\\\\", ["\""] = "\\\"",
  ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
}

local function encode_string(s)
  local out = { "\"" }
  for i = 1, #s do
    local c = s:sub(i, i)
    local b = c:byte()
    if escape_map[c] then
      out[#out + 1] = escape_map[c]
    elseif b < 0x20 then
      out[#out + 1] = string.format("\\u%04x", b)
    else
      out[#out + 1] = c
    end
  end
  out[#out + 1] = "\""
  return table.concat(out)
end

-- All-positive-integer-keyed tables encode as arrays (gaps padded with
-- "null", matching JSON-sparse-array conventions rather than silently
-- degrading a sparse table to an object).
local function array_bounds(t)
  local max_index = 0
  local any = false
  for k, _ in pairs(t) do
    any = true
    if type(k) ~= "number" or k ~= math.floor(k) or k < 1 then
      return false
    end
    if k > max_index then max_index = k end
  end
  if not any then return false end
  return true, max_index
end

local encode_value

local function encode_array(t, max_index)
  local out = {}
  for i = 1, max_index do
    local v = t[i]
    out[i] = (v == nil) and "null" or encode_value(v)
  end
  return "[" .. table.concat(out, ",") .. "]"
end

local function encode_object(t)
  local parts = {}
  for k, v in pairs(t) do
    if type(k) ~= "string" then
      error("cjson: encode only supports string keys in JSON objects, got a " .. type(k) .. " key")
    end
    parts[#parts + 1] = encode_string(k) .. ":" .. encode_value(v)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

encode_value = function(v)
  if v == nil or v == M.null then
    return "null"
  elseif v == M.empty_array then
    return "[]"
  elseif v == true then
    return "true"
  elseif v == false then
    return "false"
  elseif type(v) == "number" then
    if v ~= v then error("cjson: cannot encode NaN") end
    if v == math.huge or v == -math.huge then error("cjson: cannot encode Infinity") end
    if math.floor(v) == v and math.abs(v) < 1e15 then
      return string.format("%d", v)
    end
    return tostring(v)
  elseif type(v) == "string" then
    return encode_string(v)
  elseif type(v) == "table" then
    local mt = getmetatable(v)
    local is_arr, max_index
    if mt == array_mt then
      is_arr, max_index = array_bounds(v)
      max_index = max_index or 0
      return encode_array(v, max_index)
    end
    is_arr, max_index = array_bounds(v)
    if is_arr then
      return encode_array(v, max_index)
    end
    if next(v) == nil then
      return "{}"
    end
    return encode_object(v)
  else
    error("cjson: cannot encode a value of type " .. type(v))
  end
end

function M.encode(v)
  return encode_value(v)
end

-- Decoding ----------------------------------------------------------------

local function decode_error(msg, i)
  error("cjson: " .. msg .. " at position " .. tostring(i))
end

local function skip_ws(s, i)
  while i <= #s do
    local c = s:sub(i, i)
    if c == " " or c == "\t" or c == "\n" or c == "\r" then
      i = i + 1
    else
      break
    end
  end
  return i
end

local parse_value

local function parse_literal(s, i, lit, value)
  if s:sub(i, i + #lit - 1) == lit then
    return value, i + #lit
  end
  decode_error("invalid literal (expected '" .. lit .. "')", i)
end

local function parse_string(s, i)
  i = i + 1
  local out = {}
  while true do
    if i > #s then decode_error("unterminated string", i) end
    local c = s:sub(i, i)
    if c == "\"" then
      return table.concat(out), i + 1
    elseif c == "\\" then
      local nc = s:sub(i + 1, i + 1)
      if nc == "\"" then out[#out + 1] = "\""; i = i + 2
      elseif nc == "\\" then out[#out + 1] = "\\"; i = i + 2
      elseif nc == "/" then out[#out + 1] = "/"; i = i + 2
      elseif nc == "b" then out[#out + 1] = "\b"; i = i + 2
      elseif nc == "f" then out[#out + 1] = "\f"; i = i + 2
      elseif nc == "n" then out[#out + 1] = "\n"; i = i + 2
      elseif nc == "r" then out[#out + 1] = "\r"; i = i + 2
      elseif nc == "t" then out[#out + 1] = "\t"; i = i + 2
      elseif nc == "u" then
        local hex = s:sub(i + 2, i + 5)
        local cp = tonumber(hex, 16)
        if not cp then decode_error("invalid \\u escape", i) end
        -- BMP-only UTF-8 encode; no surrogate-pair handling. Sufficient
        -- for the config/model-catalog payloads this stub targets.
        if cp < 0x80 then
          out[#out + 1] = string.char(cp)
        elseif cp < 0x800 then
          out[#out + 1] = string.char(0xC0 + math.floor(cp / 0x40), 0x80 + (cp % 0x40))
        else
          out[#out + 1] = string.char(
            0xE0 + math.floor(cp / 0x1000),
            0x80 + (math.floor(cp / 0x40) % 0x40),
            0x80 + (cp % 0x40))
        end
        i = i + 6
      else
        decode_error("invalid escape sequence", i)
      end
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
end

local function parse_number(s, i)
  local start = i
  if s:sub(i, i) == "-" then i = i + 1 end
  while i <= #s and s:sub(i, i):match("%d") do i = i + 1 end
  if s:sub(i, i) == "." then
    i = i + 1
    while i <= #s and s:sub(i, i):match("%d") do i = i + 1 end
  end
  if s:sub(i, i) == "e" or s:sub(i, i) == "E" then
    i = i + 1
    if s:sub(i, i) == "+" or s:sub(i, i) == "-" then i = i + 1 end
    while i <= #s and s:sub(i, i):match("%d") do i = i + 1 end
  end
  local numstr = s:sub(start, i - 1)
  local n = tonumber(numstr)
  if not n then decode_error("invalid number", start) end
  return n, i
end

local function parse_array(s, i)
  i = skip_ws(s, i + 1)
  local t = {}
  local n = 0
  if s:sub(i, i) == "]" then
    if decode_array_mt_enabled then setmetatable(t, array_mt) end
    return t, i + 1
  end
  while true do
    local v
    v, i = parse_value(s, i)
    n = n + 1
    t[n] = v
    i = skip_ws(s, i)
    local c = s:sub(i, i)
    if c == "," then
      i = skip_ws(s, i + 1)
    elseif c == "]" then
      if decode_array_mt_enabled then setmetatable(t, array_mt) end
      return t, i + 1
    else
      decode_error("expected ',' or ']' in array", i)
    end
  end
end

local function parse_object(s, i)
  i = skip_ws(s, i + 1)
  local t = {}
  if s:sub(i, i) == "}" then
    return t, i + 1
  end
  while true do
    i = skip_ws(s, i)
    if s:sub(i, i) ~= "\"" then decode_error("expected string key", i) end
    local k
    k, i = parse_string(s, i)
    i = skip_ws(s, i)
    if s:sub(i, i) ~= ":" then decode_error("expected ':'", i) end
    i = skip_ws(s, i + 1)
    local v
    v, i = parse_value(s, i)
    t[k] = v
    i = skip_ws(s, i)
    local c = s:sub(i, i)
    if c == "," then
      i = skip_ws(s, i + 1)
    elseif c == "}" then
      return t, i + 1
    else
      decode_error("expected ',' or '}' in object", i)
    end
  end
end

parse_value = function(s, i)
  i = skip_ws(s, i)
  if i > #s then decode_error("unexpected end of input", i) end
  local c = s:sub(i, i)
  if c == "\"" then
    return parse_string(s, i)
  elseif c == "{" then
    return parse_object(s, i)
  elseif c == "[" then
    return parse_array(s, i)
  elseif c == "t" then
    return parse_literal(s, i, "true", true)
  elseif c == "f" then
    return parse_literal(s, i, "false", false)
  elseif c == "n" then
    return parse_literal(s, i, "null", M.null)
  elseif c == "-" or c:match("%d") then
    return parse_number(s, i)
  else
    decode_error("unexpected character '" .. c .. "'", i)
  end
end

function M.decode(s)
  if type(s) ~= "string" then
    error("cjson: decode expects a string, got a " .. type(s))
  end
  local v, i = parse_value(s, 1)
  i = skip_ws(s, i)
  if i <= #s then
    decode_error("trailing garbage after JSON value", i)
  end
  return v
end

return M
