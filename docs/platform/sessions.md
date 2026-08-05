# Sessions

Implemented. [Issue #14](https://github.com/acmiyaguchi/fen-web/issues/14)
(closed, commit `4cb0861`). `packages/platform/fnl/fen_web/sessions/`.

## Seam

Session persistence is a registerable seam in fen: the `session-backend`
register kind
(`fen/packages/core/src/fen/core/extensions/register/session_backend.fnl`)
with required methods `open`/`open-existing`/`append`/`close`/`load`/
`find`/`list`/`latest`. The stock JSONL backend
(`fen/extensions/adapters/session-backends/jsonl/`) is just one
registration of it; `fen_web.sessions` registers a second, named `:kv`.

## Registration

`fen_web.sessions.init`'s `M.register(api)` registers `:kv` as an
embedded-first-party privileged extension (`session-backend` is not in
fen's public-register-kind allowlist) — the same precedent
`fen/extensions/adapters/presenters/web/manifest.fnl` sets for the
server-side web presenter (see
[../architecture/seams.md](../architecture/seams.md)'s installation
pattern). The full method surface is registered, beyond the required
minimum: `open`/`open-existing`/`append`/`append-entry`/`create`/`close`/
`load`/`find`/`list`/`latest`/`get`/`doctor`/`acquire-lock`/
`latest-extension-state`/`info`.

The backend implementation itself lives in `kv_session.fnl`: one `host.kv`
key per session entry (zero-padded sequence number for lexicographic
ordering), a `cwd`-slug secondary index with a monotonic tiebreak for
`latest`, meta-key-based `list`/`latest`, and stale-handle-safe appends.
Locking (`acquire-lock`) is trivial in a single-page context — no
concurrent processes to lock against.

## The synchronous-kv requirement

`kv_session.fnl` assumes `get`/`put`/`delete`/`list` return synchronously.
Production `host.kv` ([`HostKv`](../bindings/kv.md)) is promise-based, and
nothing can distinguish a pending thenable from a legitimate opaque
return value by shape alone. Rather than guess, `M.register` requires an
explicit `kv.sync = true` capability flag on the table it's handed
(`assert-sync-kv!`); a table-backed test/integration kv sets it, the real
`IndexedDbKv` does not. Registering directly against unmodified
production `host.kv` therefore fails loudly today, rather than silently
treating a `Promise` as a JSON string deep inside `read-meta`/
`read-entries`. Bridging the real async `host.kv` to this synchronous
contract — the same yield-across-C-call-boundary shape
[`host-protocol.md`](../bindings/host-protocol.md) documents for fetch —
is `packages/runtime`'s job, not this module's, and is not yet built.

Depends on: [host.kv](../bindings/kv.md) (issue #3). Busted-tested against
a table-backed stub kv (`packages/platform/tests/support.fnl`); exercised
end-to-end (real registration, real `fen.core.agent` turn) by
`turn.test.ts` — see [../integration.md](../integration.md).

See also: [../architecture/seams.md](../architecture/seams.md),
[tools.md](tools.md).
