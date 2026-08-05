# Virtual FS + tools

Implemented. [Issue #4](https://github.com/acmiyaguchi/fen-web/issues/4)
(closed, commit `4cb0861`). `packages/platform/fnl/fen_web/tools/`.

## No FS seam in fen

fen has no filesystem abstraction to fill: the builtin
read/edit/write/find/grep/ls tools call `io.open`/`io.popen`/
`os.execute` directly
(`fen/extensions/behaviors/kernel/builtin-tools/`). There is nothing to
swap.

## Approach

`builtin-tools` is not loaded in the browser. Instead
`fen_web.tools.init`'s `M.register(api)` registers browser-native file
tools under the same names as an ordinary extension, via `api.register
:tool` (a public register kind — no core change needed):
`read`/`write`/`edit`/`grep`/`find`/`ls`, each matching fen's exact
builtin schema and result shape (`edit`'s algorithm is a verbatim port).
`exposure` is set to `:always` on every spec, matching fen's own
builtin-tools exposure policy (always provider-visible, not gated behind
`tool_search`). Reference:
`fen/packages/core/src/fen/core/extensions/register/tool.fnl`.

Deliberate divergence: **no `bash` tool**. fen's `bash` builtin shells out
via `os.execute`/`io.popen`, which has no browser equivalent and no
vfs-backed replacement is in scope for this issue.

## Virtual FS

`fen_web/tools/vfs.fnl` layers path/tree semantics over
[`host.kv`](../bindings/kv.md): `fs:`-prefixed keys, normalized paths,
file/directory shadowing rejected (a path can't be both a file and a
directory), and path-traversal blocked. `glob.fnl` implements `*`/`?`
globbing for `find`; `grep.fnl` uses Lua patterns, not full regex or ripgrep
syntax (a documented divergence from fen's builtin, which shells out to
`grep`/`rg`); `truncate.fnl` bounds result sizes (fen's builtin spills
oversized results to a temp file — no spill-file equivalent exists here).

## Known bug fixed during the #5 milestone

`fen_web.tools.init`'s `tool-specs` sequence literal originally ended its
list with a bare tail-position `(require :fen_web.tools.ls)`. Under a
searcher that returns two values (module, loader-data) — as fen's own
Fennel searchers and `packages/runtime`'s custom searcher both do — a
tail-position `require` splices *both* return values into the enclosing
table literal, leaking a stray string element into `tool-specs`. Fixed by
wrapping in `(pick-values 1 (require :fen_web.tools.ls))`. Regression
coverage: `turn.test.ts` asserts the registered tool set is exactly
`["edit" "find" "grep" "ls" "read" "write"]`, sorted, with no stray
element — see [../integration.md](../integration.md).

Depends on: [host.kv](../bindings/kv.md) (issue #3), [runtime
boot](../runtime/boot.md) (issue #1). 106 Busted specs cover
`packages/platform` against a table-backed stub `host.kv`
(`packages/platform/tests/support.fnl`).

See also: [../architecture/seams.md](../architecture/seams.md),
[sessions.md](sessions.md), [../integration.md](../integration.md).
