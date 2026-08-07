-- Busted bootstrap for packages/platform's Fennel sources: installs a
-- Fennel package loader so specs can `require :fen_web.shims.fs_kv` and
-- resolve straight to fnl/**/*.fnl, mirroring
-- packages/bindings/tests/helper.lua.
--
-- Platform shims sit in front of real fen core modules (fen.core.settings,
-- fen.core.llm.models) rather than replacing them, so specs also need
-- fen's own package src trees on fennel.path -- mirrors
-- fen/scripts/test/busted-helper.lua's `add_package_src` walk, scoped to
-- the two packages the shims under test actually pull in (core, util).
local fennel = require("fennel")

-- busted invokes this helper with cwd at the repo root (wherever `busted`
-- was run from), not relative to this file, so resolve source trees from
-- cwd rather than arg[0].
local platform_root = "packages/platform/fnl"
local platform_tests = "packages/platform/tests"
local fen_core_src = "fen/packages/core/src"
local fen_util_src = "fen/packages/util/src"

local roots = { "apps/web/fnl", platform_root, platform_tests, fen_core_src, fen_util_src }
local path_parts = {}
for _, root in ipairs(roots) do
  table.insert(path_parts, root .. "/?.fnl")
  table.insert(path_parts, root .. "/?/init.fnl")
end
local search_path = table.concat(path_parts, ";")

fennel.path = search_path .. ";" .. fennel.path
fennel["macro-path"] = search_path .. ";" .. fennel["macro-path"]

fennel.install()
