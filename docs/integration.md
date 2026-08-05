# Integration (`packages/integration`)

Cross-cutting harnesses that prove the full stack — runtime, bindings,
platform, and fen's real core — works together, rather than documenting a
single subsystem. Two harnesses, two very different trust levels: a fully
scripted milestone test that runs in CI, and an opt-in live harness that
never does.

## `turn.test.ts` — the #5 milestone test

Closes [issue #5](https://github.com/acmiyaguchi/fen-web/issues/5) (phase-1
milestone). Runs in `npm test`/CI, no network. Drives one real headless
agent turn — `fen.core.agent`'s `make-agent`/`step` — through
[`createFenRuntime`](runtime/boot.md) and a
[`createCoroutinePump`](runtime/boot.md#coroutine-pump-pattern), against a
scripted OpenAI Chat Completions SSE stream.

Assembly (`buildSources()` in `packages/integration/src/turn.test.ts`):
fen's `packages/core`+`packages/util` trees via `loadFenTree`, the
`packages/platform` fnl tree (`fen_web.*` shims/tools/sessions), and a
handful of manually-added modules under their *real* dotted fen names —
`fen.extensions.provider_openai.openai_completions` +
`openai_model_catalog`, and `fen.extensions.provider_shared.{init,
streaming,retry}` — because those real names come from a
luarocks/rockspec install step `loadFenTree`'s directory walk can't derive
mechanically. Deliberately not the provider's own `init.fnl`/manifest:
that also pulls in the Codex OAuth/keychain PKCE flow, out of scope for a
headless-turn test. The orchestration script that runs inside the pump
(`packages/integration/src/turnScript.fnl`) registers `openai_completions`
directly as the `:openai` provider, mirroring `init.fnl`'s own
api-key-provider-spec shape.

Host wiring: [`host.fetch`](bindings/fetch.md) is a real
[`FetchPoller`](bindings/host-protocol.md) over `ScriptedFetch`
(enqueued OpenAI-shaped SSE frames — bare `data: {...}` lines, no
`event:`, terminal `finish_reason: "stop"`, closing `data: [DONE]`, and
deliberately never a literal JSON `null` delta — see
[shims.md](platform/shims.md)'s cjson-null note and
[issue #17](https://github.com/acmiyaguchi/fen-web/issues/17)).
`host.kv` is a synchronous table-backed stub (`makeSyncKv`, the same
`sync: true` shape `packages/platform/tests/support.fnl`'s Busted stand-in
and [`sessions.md`](platform/sessions.md) use) — the kv session backend's
`sync = true` capability guard requires it, since `HostKv` is
promise-based in production and nothing yet bridges that to the
synchronous call sites `fen_web.sessions`/`fen_web.shims.fs_kv` assume.

The test also empirically verifies (issue #5 asked this be checked, not
assumed) that wasmoon calls a plain synchronous JS `__fen_host` function
synchronously from Lua, with no await needed on the Lua side — the
precondition `fs_kv.fnl`'s `install!` depends on.

Assertions cover: the assistant reply text matches the scripted
completion; no `error` event fired; `llm-start`/`llm-end` both fired;
[the six browser-native tools](platform/tools.md) registered cleanly
(`edit`/`find`/`grep`/`ls`/`read`/`write`, no stray spliced element — this
guards against the tail-`require` splice bug the milestone review found
and fixed in `fen_web.tools.init`); and the
[kv session backend](platform/sessions.md) recorded exactly two entries
(user + assistant) under `session:<id>:...` keys.

## `e2e-codex.mts` — opt-in live Codex turn

Not a test — never picked up by `npm test` or CI. Run explicitly:

```
npm run build && npm run e2e:codex
```

Validates the real stack (real wasmoon, real `fetch`, real
filesystem-backed OAuth) against live OpenAI Codex (the
ChatGPT-subscription `openai-codex` provider), reusing the user's existing
fen OAuth credentials from `~/.config/fen/auth.json` (or `FEN_AUTH_DIR`)
completely unmodified — fen's `openai_codex_keychain.fnl` runs as-is,
never patched. Exits 0 with a "skipped" message if no usable
`openai-codex` OAuth record is found; this must never fail CI or a dev's
normal flow by accident.

### The MEMFS finding

Discovered building this harness, corrected from an earlier assumption:
**wasmoon's `io`/`os` reach an Emscripten MEMFS virtual filesystem, not
the host — even under Node.** `io.open` of a real host path returns
`nil`; `os.getenv("HOME")` reads back the synthetic `/home/web_user`, not
the real `$HOME`. This is the opposite of "Lua under Node has real OS
access"; wasmoon's WASM Lua build never wires libc's file/env syscalls to
the Node process regardless of host — see
[runtime/boot.md](runtime/boot.md#in-vm-io-and-os-reach-a-virtual-filesystem-not-the-host)
for where this is now documented against `createFenRuntime`, and
[issue #18](https://github.com/acmiyaguchi/fen-web/issues/18) for the
ask to make mounting first-class instead of the workaround below.

Because patching `io.open`/`os.getenv` is off the table here (that's
exactly what the [`fs_kv` shim](platform/shims.md) does, and would defeat
the point of exercising fen's real auth-storage code unmodified), the
harness instead reaches into wasmoon's already-initialized Emscripten FS
object (`rt.lua.cmodule.module.FS` — undocumented internals, not
wasmoon's public TS surface) and mounts the real `auth.json` bytes at the
exact in-VM path (`<vmHome>/.config/fen/auth.json`, `vmHome` read back
via `os.getenv("HOME")` inside the VM, not hardcoded) that
`openai_codex_keychain.fnl` will resolve via its own unmodified
`io.open`/`os.getenv`. `getFS()` asserts the expected `mkdir`/`writeFile`/
`readFile` shape and fails loudly, naming the verified wasmoon version and
issue #18, if a wasmoon upgrade restructures those internals — never a
silent no-op.

Two more MEMFS-driven adjustments in the same harness, both narrowly
scoped and never touching `io.open`/`os.getenv`:

- `io.popen` is stubbed to return `nil` (wasmoon has no subprocess
  support at all) so `openai_codex_responses.fnl`'s module-load-time
  User-Agent detection hits its own already-documented "uname missing"
  fallback instead of crashing on a nil call — filed upstream as
  [fen#481](https://github.com/acmiyaguchi/fen/issues/481).
- `os.execute` is stubbed to return success, covering
  `openai_codex_keychain.fnl`'s `chmod 600` call on a token-refresh save
  path; the real permission tightening still happens for real once the
  harness syncs the file back to host disk (below).

### Credential-safety design

- **`finally`-sync.** `syncAuthJsonBack` runs in the `main()` `finally`
  block, on every exit path — success, a pump-timeout early exit, a
  failed kv assertion, or the top-level `catch`. A token refresh's
  rotated credentials must be persisted even if something *later* in the
  run fails, since the old refresh token is already server-invalidated
  the moment a refresh succeeds.
- **Atomic merge write-back, never a whole-file overwrite.** The harness
  reads the (possibly refresh-rewritten) `auth.json` back out of the
  VM's MEMFS copy, re-reads a *fresh* copy of the real host file, and
  merges in only the `openai-codex` key — a blind snapshot overwrite
  would clobber a concurrent edit to some other provider's record made
  outside this VM while the turn was running. The merged result is
  written to `auth.json.tmp` at mode `0o600` and then `renameSync`'d over
  the real path, mirroring fen's own `openai_codex_keychain.fnl` `save`
  (tmp file + rename, never an in-place write). A malformed VM-side JSON
  read is treated as a no-op ("malformed", not a crash) — exactly the
  case tmp+rename exists to guard the real file against.
- **Redaction.** `redactError()` scrubs `Bearer <token>` headers, the
  `access`/`refresh`/`accountId` fields of the stored keychain record,
  the OAuth token-endpoint JSON response fields
  (`access_token`/`refresh_token`/`id_token`), form-encoded
  `refresh_token=...` bodies, and `chatgpt-account-id` headers — applied
  to every error path, including the top-level `main().catch`. Successful
  runs log only structural facts (booleans, counts, timings, the assistant
  reply text and event names); no path in this file prints token contents
  or raw `auth.json` contents.

See also: [runtime/boot.md](runtime/boot.md) for the coroutine pump and
`createFenRuntime` surface both harnesses drive,
[bindings/host-protocol.md](bindings/host-protocol.md) for the fetch poll
protocol, [platform/shims.md](platform/shims.md) for `fs_kv` and the host
IO profiles this harness deliberately opts out of, and
[platform/sessions.md](platform/sessions.md) /
[platform/tools.md](platform/tools.md) for the registered pieces both
scripts exercise.
