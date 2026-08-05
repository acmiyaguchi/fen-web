# Sessions

Planned. [Issue #14](https://github.com/acmiyaguchi/fen-web/issues/14).
Not yet implemented.

## Seam

Session persistence is already a registerable seam in fen: the
`session-backend` register kind
(`fen/packages/core/src/fen/core/extensions/register/session_backend.fnl`)
with required methods `open`/`open-existing`/`append`/`close`/`load`/
`find`/`list`/`latest`. The stock JSONL backend
(`fen/extensions/adapters/session-backends/jsonl/`) is just one
registration of it — fen-web adds a second.

## Approach

Register an IndexedDB-backed session backend over
[`host.kv`](../bindings/kv.md). No fen core change needed. It is a
privileged register kind, but the embedded-first-party pattern is already
established — the `web` presenter
(`fen/extensions/adapters/presenters/web/manifest.fnl`) does the same
thing.

- Implement the required methods first.
- Optional methods (`acquire-lock`, `doctor`, ...) as needed — locking is
  trivial in a single-page context (no concurrent processes).

Depends on: [host.kv](../bindings/kv.md) (issue #3, implemented). Part of
the design-investigation follow-ups on fen#99. Busted-testable on desktop
against the stub `host.kv` (`MemoryKv`).

See also: [../architecture/seams.md](../architecture/seams.md),
[tools.md](tools.md).
