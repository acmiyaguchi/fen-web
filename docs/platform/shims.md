# Platform shims

Planned. [Issue #15](https://github.com/acmiyaguchi/fen-web/issues/15).
Not yet implemented.

fen core leaks `os`/`io`/native modules past the HTTP and FS seams. These
block the headless turn (#5) and need small browser shims, preloaded into
`package.loaded` from the runtime bootstrap — same pattern as the HTTP
backend stub in `fen/packages/testing`. Policy stays in Fennel; each shim
is meant to be tiny.

## Needed shims

| fen dependency | Source | Shim |
|---|---|---|
| `fen.util.process.monotonic-ms` (native `fen_process`) | agent latency timing; retry's coop sleep (busy-yield to a monotonic deadline) | `performance.now()` via host. Also used by reload diagnostics — see [../runtime/reload.md](../runtime/reload.md) |
| `fen.util.random` (native module) | — | `crypto.getRandomValues` |
| `os.time` timestamps | `fen/packages/core/src/fen/core/types.fnl`, `fen/packages/core/src/fen/core/tools.fnl` | `Date`-equivalent host binding or a preloaded `os` table subset |
| `core/settings.fnl` (`io.open`, `os.remove`) | settings persistence | `host.kv`-backed |
| `core/llm/models.fnl` (`io.open`, `os.getenv` for API keys) | model/key config | `host.kv`-backed; this is where BYO-key storage (issue #7) plugs in |

`core` only needs `monotonic-ms` from `fen.util.process` — no other method
of that module is required for the headless turn.

## Mechanism

Same as the HTTP backend: preload replacement Fennel modules into
`package.loaded` before the rest of core requires them, rather than
patching fen. See [../architecture/seams.md](../architecture/seams.md) for
the general installation pattern (note: these are not registrable seams,
just hard dependencies that need blind substitution).

Blocks [issue #5](https://github.com/acmiyaguchi/fen-web/issues/5)
(headless turn milestone).

See also: [../bindings/kv.md](../bindings/kv.md),
[../runtime/reload.md](../runtime/reload.md).
