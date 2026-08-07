# apps/web

In progress. Issue #6 (DOM presenter) is implemented; #7-#9 are planned.

Self-contained single page: IndexedDB-backed virtual FS, sandboxed iframe
preview the agent can drive, BYO API key. No key-proxy infrastructure —
see the top-level [README.md](../../README.md) non-goals.

## Shape (by issue)

- **#6 — DOM presenter (implemented).** A presenter register-kind
  extension in `apps/web/fnl/fen_web/web` that replaces the termbox2 TUI
  with a browser DOM UI over [`host.dom-apply`](../bindings/dom.md), while
  reusing fen's compositional model unchanged: it contributes `:status`
  and `:panel` items and folds `api.on :*` bus events into a transcript
  (`ingest.fnl`), exactly like the in-tree TUI/web presenters. `layout.fnl`
  turns that state into a structured fragment (plain `{:text :style}` rows,
  not `fen.util.panel`'s terminal box-drawing) and `dom.fnl` diffs it into
  one batched `host.dom-apply` mutation list per frame against a committed
  model. That committed model, the transcript, status, and any in-flight
  prompt/select live in the reload-excluded `state.fnl`, so `/reload` swaps
  behavior in-page without rebuilding live DOM — the TUI/web state-module
  split. `api.ui.prompt`/`api.ui.select` are real modal DOM overlays
  awaited cooperatively by yielding the active turn coroutine; the web
  presenter's `web-prompt` was unimplemented, so this is the first real
  browser prompt. Input never calls back into Lua: `listen` ops enqueue
  events the run loop drains poll-style. The single-page HTML shell that
  mounts `#fen-app` and wires `__fen_host.dom_apply` is #7.
- **#7 — shell + BYO-key settings (implemented).** The single-page shell
  (`apps/web/index.html` + `apps/web/src/*.ts`, bundled by Vite) wires
  the runtime + bindings + DOM presenter into a working page and runs the
  agent end to end. The runtime-wiring gap deferred from #6's PR is
  closed: `src/boot.ts` installs `__fen_host` with `kv`/`dom_apply`/
  `fetch_*`, installs the fen-web fetch backend, and drives the presenter
  turn loop inside the runtime coroutine pump; the register/agent/turn
  orchestration itself lives in Fennel
  (`apps/web/fnl/fen_web/web/boot.fnl`, the browser analog of fen's
  `fen.interactive.run!`). Rather than re-implement the interactive
  turn/tick loop, `boot.fnl` reuses fen's own lifecycle modules —
  `fen.run_state`, `fen.turn_submit`, `fen.turn_lifecycle`, and
  `fen.session_lifecycle` (make-flush/`:message-appended` install/close) —
  so the canonical `:runtime-tick`/`:agent-started`/`:agent-turn-complete`/
  `:agent-shutdown` events reach extensions exactly as they do under the
  TUI. The tool and DOM-presenter extensions load through their manifests
  via the extension loader's public api factory + manifest reader
  (`load-extension!`), so `reload-modules`/`reload-exclude` and owner
  cleanup are real; the full CLI loader can't run in-VM (its compiler dep
  pulls `fen.runtime`), and an end-to-end in-page `/reload` is tracked as
  fen-web#19. BYO API keys are entered in the shell's settings gate
  (`src/settings.ts`) and stored in IndexedDB under `env/apikey/<VAR>` —
  the exact path the `fs_kv` shim maps `os.getenv` to
  ([../platform/shims.md](../platform/shims.md)). The key is resolved
  in-VM via `os.getenv("<VAR>")` from the provider's `:api-key-var` (not
  marshalled through a JS global), so it never leaves the browser (sent
  only in the provider request's auth header, directly to the provider
  API; no key proxy). Changing or forgetting the key cooperatively stops
  the running VM (`DemoSession.stop`) before erasing/replacing storage, so
  the old key snapshot is actually revoked. Only `"anthropic"` is accepted
  today; other providers are rejected up front rather than silently routed. Provider order: Anthropic is wired
  first because `api.anthropic.com` accepts direct-from-page calls (the
  fetch backend adds the required `anthropic-dangerous-direct-browser-access`
  header for that host, see [../bindings/fetch.md](../bindings/fetch.md));
  OpenAI-compatible endpoints (incl. OpenRouter) follow as their provider
  extensions land in the bundle. fen's kv-backed seams (sessions,
  `fs_kv`) call kv synchronously, so the shell mirrors IndexedDB into a
  `SyncKvCache` (`packages/bindings`) at boot — see
  [../bindings/kv.md](../bindings/kv.md). The cache's asynchronous write-back
  callback is connected to the existing non-destructive page-error notice and
  diagnostics ring, so quota/connection failures are not silently swallowed;
  failed keys remain pending until a later flush really commits them. The
  shell flushes the cache periodically and when the document becomes hidden;
  `beforeunload` remains a final best-effort attempt. The periodic timer is
  disarmed for `pagehide` and re-armed exactly once on every `pageshow`, so a
  bfcache restore does not silently lose periodic durability.

  **Storage durability.** At browser boot the shell makes one best-effort
  `navigator.storage.persist()` request and records its result plus
  `navigator.storage.estimate()` (`usage`/`quota`) in the stable diagnostics
  context, as well as the event ring. A fresh estimate is requested before a
  diagnostics report is copied and opportunistically after a write-back
  failure, with the boot-time value as the fallback. Missing or denied
  StorageManager APIs are recorded and do not prevent boot. Persistence is a
  browser eviction hint rather than a backup: users should still export
  important work when that feature is added.

  **Fatal errors and restart.** A presenter/run-loop failure, an in-VM boot
  error, or an uncaught browser error is shown in the shell as a fatal panel
  with the error message and stack when available. Before a failed VM is
  closed, the browser awaits the cache's pending IndexedDB write-backs
  (best-effort, since flushing can itself fail). The **Restart** action then
  runs the complete browser boot path again, including a new runtime and a
  fresh synchronous kv snapshot. It never reuses the poisoned Lua state:
  `fs_kv.install!` and the web boot patch VM globals without an uninstall
  operation. The durable seed remains seed-if-empty, so restart preserves
  the user's workspace. Restart clears the old presenter mount before the
  fresh VM renders, disposes the old preview iframe/message bridge and
  IndexedDB connection, and bounds cooperative shutdown with a hard-close
  fallback. A restart without stored provider credentials returns to the
  settings gate instead of booting a VM that cannot resolve its key.

  **Diagnostics and reporting.** The Settings panel has **Copy diagnostics**;
  fatal panels, non-destructive page-error notices, and transcript error rows
  have the same one-tap action. Reports are plain Markdown/text and include the
  error and stack when applicable, provider/model, fen and fen-web versions,
  browser UA, and the last 50 terse turn/bus events. A later preview-console
  capture (#34) can fill the optional `Preview console (tail)` section; it is
  intentionally not captured here. The shell does retain a small recent host
  console tail for on-demand reports. Diagnostics are collected in JS at the
  presenter `api.on :*` → `__fen_host.diagnostics_event` seam, never by
  querying the VM during a coroutine. Request bodies are not recorded, and
  high-frequency streaming deltas are excluded so a long answer cannot evict
  the events that explain a failure. Bus-event summaries can, however,
  include short excerpts of prompts, responses, and tool output — the bundle
  says so in its header, and users should review before sharing publicly.
  Before formatting, stored API-key values, authorization/x-api-key-style
  headers, bearer/provider tokens, JWT-like values, and long high-entropy
  token-looking strings are replaced with `[REDACTED]`. Clipboard writing uses
  `navigator.clipboard.writeText` with a selection-based fallback for mobile.

  **Bundler/dev-server:** Vite (`apps/web/vite.config.ts`). `npm run dev
  -w @fen-web/web` serves the page; `npm run build` produces the static
  bundle. The fen submodule + fen-web Fennel trees are inlined at bundle
  time via `import.meta.glob(..., {query:'?raw'})` and mapped to dotted
  `require` names in `src/sources.ts` (the browser analog of
  `loadFenTree`); the vendored Fennel compiler and cjson stub are bundled
  as raw text and passed to `createFenRuntime` so its Node-only `fs`
  readers never run in-page (see [../runtime/boot.md](../runtime/boot.md)).
- **#8 — sandboxed iframe preview + `preview.*` tools (implemented).**
  `preview_refresh` re-renders the IndexedDB tree into a sandboxed
  `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).
  `preview_query(selector)`, `preview_click(selector)`,
  `preview_fill(selector, value)`, `preview_eval(expr)` drive the running
  app via a `postMessage` RPC channel; `preview_screenshot` renders a
  canvas → dataURL. The RPC is the new `host.preview` primitive
  (`packages/bindings/src/preview`, [../bindings/preview.md](../bindings/preview.md));
  the page assembly (rendering the vfs tree, inlining same-tree
  stylesheet/script refs) and the six tools live in Fennel
  (`apps/web/fnl/fen_web/web/preview`), registered demo-only through the
  per-owner manifest loader (`fen_web.web.boot.load-extension!` on
  `fen_web.web.preview.manifest`) — the same path the file tools use, not
  an ad-hoc one. Like `host.fetch`, the RPC is asynchronous, so each tool
  starts/polls/yields the turn coroutine between polls rather than blocking.
- **#9 — starter project.** A curated starter todo app is seeded into the
  IndexedDB-backed vfs on first load (open question in fen#99: curated
  starter vs. boot empty — resolved in favor of seeding, so the
  preview-driving loop is demoable in one click). The starter files are
  real, reviewable source under `apps/web/starter/` (`index.html` +
  `app.js` + `styles.css`); the browser bundles them to raw text via
  `import.meta.glob` (`src/starter.ts`). **Durable, race-safe seed
  mechanism.** The seed runs in the JS/durable layer, not the Lua VM:
  `browserBoot.ts` validates the bundle (`validateStarterFiles` — a
  missing/malformed bundle fails boot loudly, since the starter is required)
  and commits it with `IndexedDbKv.seedIfEmpty` **before** the synchronous
  `SyncKvCache` snapshot is taken. That commit is a single conditional
  IndexedDB transaction: because IndexedDB serializes readwrite transactions
  on the store, the emptiness check and the writes cannot interleave with
  another tab, so a concurrent seed sees the marker/files and no-ops —
  **user work is never clobbered**. It is all-or-nothing (the whole
  transaction aborts on any error, persisting nothing) and durable (resolves
  only on `oncomplete`), so a page close / quota / abort leaves the store
  untouched and the next boot retries rather than inheriting a broken
  half-seed. **Seed-once gate:** seed only when the seed-complete marker
  (`seed:starter-complete`, outside the `fs:` keyspace) is absent AND no
  `fs:` file exists; the marker is written last within the same transaction,
  and the gate is a cheap marker `get` + one-step key cursor, never a full
  workspace walk. The seeded `/index.html` renders through the existing
  `preview_refresh`/`build-page` assembler out of the box (same-tree
  `styles.css`/`app.js` inlined). Coverage:
  `packages/bindings/src/kv/starterSeed.test.ts` (validation, empty-seed,
  idempotence, no-clobber), `apps/web/tests/seed_test.fnl` (the seeded
  entry renders through both `build-page` and `preview_refresh`), and the
  end-to-end seed assertion in `apps/web/src/bootTurn.test.ts`.

## Sandboxing invariant

The preview iframe runs with `sandbox="allow-scripts"` only — **no**
`allow-same-origin`. Agent tools reach it exclusively through the
`postMessage` RPC channel. User-generated JS in the preview cannot reach
the parent frame's virtual FS, the API key, or any forge token. This
invariant is load-bearing for BYO-key safety and must not be relaxed to
fix a preview capability gap — widen the RPC surface instead. The
`host.preview` primitive enforces it: it creates the iframe with only
`allow-scripts`, validates that inbound RPC replies come from the iframe's
own window (`event.source === iframe.contentWindow`; origin is `"null"` for
a sandboxed frame and so is not a usable allowlist key), and never posts
any secret into the iframe. Coverage:
`packages/bindings/src/preview/webHostPreview.test.ts` (sandbox attribute,
foreign-source rejection) and `apps/web/tests/preview_test.fnl` (the page
assembler never emits the stored API key). See
[../bindings/preview.md](../bindings/preview.md).

See also: [../architecture/fennel-first.md](../architecture/fennel-first.md)
(`host.dom-apply` role), [extension.md](extension.md) for the other
delivery shape.
