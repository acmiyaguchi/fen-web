-- Busted bootstrap for apps/demo's Fennel sources: installs a Fennel
-- package loader so specs can `require :fen_web.demo` and resolve straight
-- to fnl/**/*.fnl, mirroring packages/platform/tests/helper.lua.
--
-- The demo presenter reuses fen core/util modules (fen.util.json,
-- fen.util.tokens, the panel/status register kinds), so specs also need
-- fen's own package src trees on fennel.path -- scoped to core + util, the
-- two packages the presenter pulls in.
local fennel = require("fennel")

-- busted invokes this helper with cwd at the repo root, not relative to this
-- file, so resolve source trees from cwd.
local roots = {
  "apps/demo/fnl",
  "apps/demo/tests",
  "fen/packages/core/src",
  "fen/packages/util/src",
}
local path_parts = {}
for _, root in ipairs(roots) do
  table.insert(path_parts, root .. "/?.fnl")
  table.insert(path_parts, root .. "/?/init.fnl")
end
local search_path = table.concat(path_parts, ";")

fennel.path = search_path .. ";" .. fennel.path
fennel["macro-path"] = search_path .. ";" .. fennel["macro-path"]

fennel.install()
