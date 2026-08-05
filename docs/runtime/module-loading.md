# Module loading

Decided in [issue #16](https://github.com/acmiyaguchi/fen-web/issues/16)
(closed), which found the option-3 hybrid after a wasmoon + Fennel 1.6.0
spike. Feeds #1 (runtime boot) acceptance criteria.

## Constraints

fen pins `FENNEL_VER := 1.6.0` in its Makefile and treats compiler version
as a checked invariant; fen-web must match. 1.5.3 also works but ships
different codegen, so the version-parity check matters, not just "a 1.x
compiler."

## Measurements (Node, cold VM; floors — stub errors on call, proves loadability only)

| Metric | Value |
|---|---|
| wasmoon bundle | ~425KB (wasm+js) |
| fennel-1.6.0.lua | 295KB |
| Engine boot | ~82ms |
| Fennel load | ~207ms |
| All 69 `.fnl` under `fen/packages/{core,util}/src`, in-VM compile | 0 failures, ~60ms/file |
| Cold `(require :fen.core.agent)` via custom searcher | 33 modules, ~1.7s (compile+load+exec) |
| Full-tree reload (33 modules cleared) | ~1.5s — only ~10% faster than cold; no compiler-level cache |
| Single-file reload (one leaf + entry cleared, deps cached) | ~300ms |

No macros exist anywhere in `core`/`util`, so `compileString` needs no
compiler-env (caveat: `fen/testing/macros.fnl` exists if tests ever run
in-page). Stubs needed for cold load: `cjson`, `fen.util.process` only.

## The decision

1. **Pinned core: precompiled at bundle time, excluded from `/reload`.**
   Removes the 1.7s page-load compile and the version-skew surface.
   Requires extending `NON-RELOADABLE`/`core-reloadable?` in
   `fen/packages/core/src/fen/core/extensions/loader/reload.fnl` (lines
   ~180-190) to exclude the pinned tree.
2. **App trees + user extensions: in-VM compile-on-require** via a custom
   `package.searchers` entry over the virtual FS, Fennel 1.6.0 vendored
   with a version-parity check mirroring `fen/flake.nix`'s pin assertion.
   User-authored extensions from the virtual FS are in scope day one — the
   registry and reload mechanism already support them.
3. **`/reload` scope: app/user trees only**, at single-file granularity
   (~300ms). Full-tree reload stays available but is a ~1.5s operation.
   Detail: [reload.md](reload.md).
4. Only ~10% of full-tree reload's cost is amortizable without a
   compiler-level cache — see the chunk-cache follow-up in
   [reload.md](reload.md), tracked as
   [issue #19](https://github.com/acmiyaguchi/fen-web/issues/19) (never
   filed until this pass): persist compiled chunks in `host.kv` keyed on
   `(fennel-version, source-fingerprint)` to cut every page load's ~1.7s
   cold-compile cost. Not yet implemented — `createFenRuntime`
   ([boot.md](boot.md)) always compiles in-VM today, with nothing
   persisted across boots.

## Why hybrid, not pure-precompiled or pure-in-VM

Pure precompiled-everything loses the "Fennel is the fast loop" property
that reload exists for. Pure in-VM-everything pays the 1.7s compile on
every cold load and expands the version-skew surface to code that never
changes. The hybrid pays compile cost once (bundle time) for code that's
pinned and immutable at runtime, and keeps the fast loop for code that
actually gets edited.

See also: [reload.md](reload.md), [boot.md](boot.md),
[../architecture/seams.md](../architecture/seams.md).
