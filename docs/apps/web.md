# apps/web

In progress. Issue #6 (DOM presenter), #7-#9, and the BYO-key provider work for #31/#32 are implemented.

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

### Status bar

The DOM status bar keeps the existing `ctx:~N` context estimate and adds
session usage as compact `N/N tok` totals. `turn:N/N tok` shows the current
(or most recently completed) logical agent turn after usage arrives; it sums
all provider rounds in that turn, including rounds separated by tool calls.
The `~$0.012` entry is an estimate, not a bill: it is shown only when the
exact model id has an entry in the best-effort, manually maintained pricing
table (`claude-haiku-4-5` is currently $1/M input and $5/M output). Anthropic
cache-read and cache-write usage is included in that estimate at 0.1x and
1.25x the ordinary input rate respectively. Unknown models silently omit the
cost entry.

Usage is folded from the canonical `:llm-end` event. The Anthropic adapter
merges `message_start.message.usage.input_tokens` with
`message_delta.usage.output_tokens` into the assistant's canonical
`usage.input`/`usage.output`, and also carries `cache_read_input_tokens` and
`cache_creation_input_tokens` as `usage.cache-read`/`usage.cache-write`; the
agent then emits that complete usage table on `:llm-end`. Provider SSE message
deltas themselves are not bus events, so the presenter counts the `:llm-end`
table once and does not double-count streaming updates.

Token totals live in the presenter's in-memory state for the current runtime
session only. They are not persisted to the virtual filesystem. A browser
**Restart** creates a fresh VM/session, so the totals reset; `/reload` within
the same runtime retains presenter state.

### Stop / cancellation

While a turn is running, the input bar adds a **Stop** button. Pressing
**Escape** is equivalent. Both paths call the JS `DemoSession.cancel()` seam,
which asks the in-VM presenter to cancel cooperatively and immediately aborts
every active `host.fetch` request; they do not tear down the VM. The presenter
then emits fen's canonical `:cancelled` lifecycle event, keeps streamed
transcript rows, and returns to the idle state so another prompt can be sent.
Stopping while idle is a no-op. If the run loop crashes or the VM is closed,
its fetch poller aborts all remaining transports before closing the runtime.

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
  the old key snapshot is actually revoked. The same settings gate has a
  provider-specific **Model** dropdown. Its conservative static catalog is
  defined once in `src/settings.ts`; Anthropic offers `claude-haiku-4-5`
  (the default), `claude-sonnet-5`, and `claude-opus-5`. OpenAI offers the
  Fen-documented `gpt-5.4-nano`. OpenRouter offers the namespaced,
  best-effort `anthropic/claude-haiku-4.5` (default) and
  `openai/gpt-5.4-nano`; its live `/models` catalog is authoritative outside
  this static settings gate. In dev builds the Codex provider's pinned
  `gpt-5.6-luna`
  (default), `gpt-5.6-sol`, and `gpt-5.6-terra` entries are shown when that
  provider is selected. The selected model is stored per provider under
  `settings/selected-model/<provider>` in the same IndexedDB-backed settings
  store, so reload, **Restart**, and **Save & restart** use it. The web pricing
  table includes a clearly marked, unverified/manual estimate for plain
  OpenAI `gpt-5.4-nano` ($0.20/M input, $1.25/M output); this is not an
  authoritative billing source. OpenRouter cost estimates are intentionally
  omitted because its price varies by the underlying model, so those models
  show token counts but no cost estimate rather than a silently guessed value.
  Anthropic, OpenAI, and OpenRouter are BYO-key, browser-direct providers; Codex remains
  dev-server-only through the local OAuth bridge. Unsupported providers are
  rejected up front rather than silently routed. Anthropic is wired first
  because `api.anthropic.com` accepts direct-from-page calls (the fetch
  backend adds the required `anthropic-dangerous-direct-browser-access`
  header for that host, see [../bindings/fetch.md](../bindings/fetch.md)).
  OpenAI and OpenRouter use Fen's existing Chat Completions adapter with base
  URLs `https://api.openai.com/v1` and `https://openrouter.ai/api/v1`,
  respectively. Keys are stored under `env/apikey/OPENAI_API_KEY` or
  `env/apikey/OPENROUTER_API_KEY` and are resolved in-VM through the same
  diagnostics-secret path as Anthropic. There is no key proxy.

  **CORS and servicing-basis report (#7, #31, #32).** On 2026-08-07, a
  curl preflight probe with `Origin: https://fen-web.example.test`,
  `Access-Control-Request-Method: POST`, and
  `Access-Control-Request-Headers: authorization,content-type` returned:
  OpenAI `HTTP/2 200` with `access-control-allow-origin:
  https://fen-web.example.test`, `access-control-allow-headers:
  authorization,content-type`, and `access-control-allow-methods: GET,
  OPTIONS,POST`; OpenRouter `HTTP/2 204` with
  `access-control-allow-origin: *`, an allow-list containing Authorization
  and Content-Type, and POST in `access-control-allow-methods`. Both are
  therefore currently marked `browserDirect: true`; this is an operational
  probe, not a permanent provider guarantee. The servicing-basis decision
  for the #7 thread is OpenRouter as the browser-direct star because its
  documented CORS response is explicit and includes the browser-call
  headers, while OpenAI's behavior should be re-probed if deployment fails.
  OpenRouter's optional `HTTP-Referer`/`X-Title` attribution headers are not
  sent: pinned Fen v0.17 has the `base-url` seam but no extra-headers option
  (fen#492), and the read-only submodule cannot be changed in this lane. The browser workspace extension registers
  fen-compatible `read`/`write`/`edit`/`grep`/`find`/`ls` plus `glob`,
  `truncate`, guarded file-only `delete`/`move`, and registry-generic
  `tool_search`. `web_fetch` is deliberately **not registered by default**:
  callers may pass `enableWebFetch: true` to `bootDemo` when they explicitly
  accept that browser-direct targets need permissive CORS and that fetched
  pages are an untrusted prompt-injection surface. There is no settings UI
  for this flag yet. fen's kv-backed seams (sessions,
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
  browser UA, the last 50 terse turn/bus events, and the bounded recent
  `Preview console (tail)` retained by the preview host. The shell also retains
  a small recent host console tail for on-demand reports. Diagnostics are
  collected in JS at the presenter `api.on :*` → `__fen_host.diagnostics_event`
  seam, never by
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
  **Dev console forwarding.** During `vite dev` only, the index transform installs
  a small host-page console bridge before `src/main.ts`. It observes `log`,
  `info`, `warn`, `error`, `debug`, and `trace`, plus uncaught errors and
  unhandled rejections, and sends bounded batches to the loopback/tailnet-only
  `/__fen/console` middleware. The middleware prints compact `[web:*]` lines
  (with terminal colors when available), rejects cross-site and oversized
  requests, and is absent from the Pages build. The bridge is intentionally
  host-page-only; the preview iframe's console remains available through
  `preview_console` (#34). We evaluated `vite-plugin-terminal`, but did not
  add it because this small custom bridge meets the need without a dependency.

- **#8 — sandboxed iframe preview + `preview.*` tools (implemented).**
  `preview_refresh` re-renders the IndexedDB tree into a sandboxed
  `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).
  `preview_query(selector)`, `preview_click(selector)`,
  `preview_fill(selector, value)`, `preview_eval(expr)` drive the running
  app via a `postMessage` RPC channel; `preview_screenshot` renders a
  canvas → dataURL, and `preview_console` drains bounded console output and
  uncaught errors. Click/fill/eval also append a terse marker when an uncaught
  error is waiting. The RPC is the new `host.preview` primitive
  (`packages/bindings/src/preview`, [../bindings/preview.md](../bindings/preview.md));
  the page assembly (rendering the vfs tree, inlining same-tree
  stylesheet/script refs) and the seven tools live in Fennel
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

- **#41 — workspace visibility (implemented).** The shell-owned panel in
  `src/workspacePanel.ts` reads the durable `fs:` keyspace directly through a
  separate `IndexedDbKv` connection. It displays implicit directories and
  files in a collapsible tree; selecting a file shows its contents in a
  read-only `<pre>`. Refresh and download first flush the VM's
  `SyncKvCache`, so the viewer does not intentionally hide pending writes.
  **Download ZIP** emits a hand-rolled classic ZIP with UTF-8 names, stored
  entries, and CRC32 checksums; vfs `/` is removed from archive names so an
  extraction cannot be treated as an absolute filesystem path. **Reset to
  starter** is confirmation-guarded, stops the VM before clearing every `fs:`
  key and `seed:starter-complete`, reseeds through `IndexedDbKv.seedIfEmpty`,
  and boots a fresh session from the new snapshot. The reset leaves settings,
  credentials, and session metadata untouched. Import/drop-in files remain a
  stretch and are intentionally not included. Unit coverage for the tree,
  reset, and ZIP round-trip is in `src/workspacePanel.test.ts`; browser e2e
  does not exercise the download prompt, so ZIP parsing is tested in Node.
- **#40 — session management and slash commands (implemented).** Browser boot resumes the newest non-empty session for the configured workspace from the kv backend and hydrates its canonical messages into local transcript rows without re-appending them. The minimal command surface is `/new` (fresh conversation), `/sessions` (newest-first list with ids, timestamps, summaries, and message counts), `/sessions use <id>` (switch and re-render), `/sessions delete <id>` (delete, or start a replacement when deleting the active session), and `/help`. Unknown slash commands render a local error; non-slash input still follows the normal provider turn and Stop/cancellation path. Session deletion removes metadata, entries, and secondary indexes from the kv backend. Transcript export is intentionally deferred to the workspace/export work in #41 because there is no cheap stable browser download seam in this lane. **Follow-up:** kv sessions still append one record per message and do not compact old transcripts; compaction remains out of scope for #40.

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

## Browser notifications

The settings panel owns the optional browser notification permission. Its
**Enable browser notifications** button calls `Notification.requestPermission()`
only from that user gesture. The always-exposed `notify(title, body?)` tool
never prompts: a granted permission sends the title/body through the host seam,
while denied or unavailable permission creates an in-app transcript notice and
returns a clean `permission not granted` error. The host rate-limits attempts
to one every few seconds, and iOS Safari/non-PWA environments use the
transcript fallback.

## Browser e2e

The Chromium-only browser tier lives in `packages/e2e`. It builds the app and
runs it through `vite preview`, while Playwright route interception supplies
strict, ordered Anthropic Messages SSE fixtures; no provider credential or
network request is used. Each test gets a fresh browser context, including a
fresh IndexedDB origin.

After `npm ci`, install the browser once with:

```sh
npx playwright install chromium
```

Run the suite headlessly with:

```sh
npm run e2e -w @fen-web/e2e
```

The Playwright config starts `npm run build` followed by
`npm run preview -w @fen-web/web` automatically. On CI, the Chromium download
is cached and traces/reports are uploaded when the e2e job fails. The OpenAI
and OpenRouter providers are not added to this tier: making the deterministic
OpenAI-compatible SSE fixture pass through the mock router would require a
second router/route harness; the focused OpenRouter wire path is covered by
`apps/web/src/bootTurn.test.ts`.
