# Reload

Decided alongside module loading in
[issue #16](https://github.com/acmiyaguchi/fen-web/issues/16) (closed).
`fen/packages/core/src/fen/core/extensions/loader/reload.fnl` is reused,
not rewritten, but needs three substitutions plus the v0.17 path/clock seam
fulfillments already supplied by `packages/runtime`.

## Scope

`/reload` covers **app/user trees only**, at single-file granularity
(~300ms: one leaf + entry cleared, dependencies stay cached). Pinned core
(`fen/packages/{core,util}`) is precompiled at bundle time and excluded —
see [module-loading.md](module-loading.md). Full-tree reload of the
reloadable scope stays available as a ~1.5s operation.

## The three substitutions + v0.17 seams

1. **`compiler.fnl` swap** — in-VM `compileString` honoring the
   `{:status :outputs}` contract, instead of shelling out.
2. **`discover.fnl` / `manifest.fnl` swap** — walk `host.kv` instead of
   `io.popen`/`lfs`, which don't exist in the browser.
3. **`fen.util.checksum` swap** — the stock implementation fingerprints via
   `io.open` + `package.searchpath`, which is blind to modules loaded
   through the custom searcher (see [module-loading.md](module-loading.md))
   and would force a full reload every time. Replace with `host.kv`
   versions/etags.
4. **`FEN_DEV_PATH`/`dev-overlay-fnl?` path seam** —
   `reload.fnl:133` now asks `fen.util.path.getenv`, not `os.getenv` directly.
   The browser's preloaded `fen.util.path.backend` supplies the host-visible
   value (or nil), so the compiler path is an explicit backend fulfillment,
   not a global environment patch.

## Follow-up (not blocking)

Persisted chunk cache in `host.kv`, keyed on
`(fennel-version, source-fingerprint)`, to cut warm page loads. Note:
`reload.fnl:112` currently loads with mode `"t"` (text only) — a
`string.dump` bytecode cache needs that mode widened to `"bt"`. Prior art:
`fen/scripts/test/fennel_compile_cache.lua`. Rockspec/native-build tooling
(`rocks.fnl`, `build.fnl`) stays permanently out of browser scope. Filed
as [issue #19](https://github.com/acmiyaguchi/fen-web/issues/19); not yet
implemented.

## Related v0.17 seams

- `fen.util.clock.monotonic-ms` must come from a real wall clock
  (`performance.now` via `fen.util.clock.backend`), not `os.clock` — reload
  diagnostics use it.
- `fen.util.path.getenv` is the host-facing environment seam used by the
  dev-overlay gate. The browser runtime fulfills it directly; `fs_kv`'s old
  `os.getenv` patch is not involved.

These are tracked under [../platform/shims.md](../platform/shims.md) (issue
#15). The `fs_kv` direct-IO shim is likewise separate from reload module
discovery and config storage.

See also: [module-loading.md](module-loading.md),
[../architecture/seams.md](../architecture/seams.md).
