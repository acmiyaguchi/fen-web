-- Busted bootstrap for packages/bindings' Fennel sources: installs a
-- Fennel package loader so specs can `require :fen.util.http.backends.fetch`
-- and resolve straight to fnl/**/*.fnl, mirroring
-- fen/scripts/test/busted-helper.lua's approach (fennel.path, not
-- package.path, since fennel.install()'s searcher reads fennel.path).
local fennel = require("fennel")

-- busted invokes this helper with cwd at the repo root (wherever `busted`
-- was run from), not relative to this file, so resolve the fnl tree from
-- cwd rather than arg[0].
local fnl_root = "packages/bindings/fnl"

fennel.path = fnl_root .. "/?.fnl;" .. fnl_root .. "/?/init.fnl;" .. fennel.path
fennel["macro-path"] = fnl_root .. "/?.fnl;" .. fennel["macro-path"]

fennel.install()
