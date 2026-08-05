# apps/demo

In progress. Issue #6 (DOM presenter) is implemented; #7-#9 are planned.

Self-contained single page: IndexedDB-backed virtual FS, sandboxed iframe
preview the agent can drive, BYO API key. No key-proxy infrastructure —
see the top-level [README.md](../../README.md) non-goals.

## Shape (by issue)

- **#6 — DOM presenter (implemented).** A presenter register-kind
  extension in `apps/demo/fnl/fen_web/demo` that replaces the termbox2 TUI
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
  (`apps/demo/index.html` + `apps/demo/src/*.ts`, bundled by Vite) wires
  the runtime + bindings + DOM presenter into a working page and runs the
  agent end to end. The runtime-wiring gap deferred from #6's PR is
  closed: `src/boot.ts` installs `__fen_host` with `kv`/`dom_apply`/
  `fetch_*`, installs the fen-web fetch backend, and drives the presenter
  turn loop inside the runtime coroutine pump; the register/agent/turn
  orchestration itself lives in Fennel
  (`apps/demo/fnl/fen_web/demo/boot.fnl`, the browser analog of fen's
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
  [../bindings/kv.md](../bindings/kv.md).

  **Bundler/dev-server:** Vite (`apps/demo/vite.config.ts`). `npm run dev
  -w @fen-web/demo` serves the page; `npm run build` produces the static
  bundle. The fen submodule + fen-web Fennel trees are inlined at bundle
  time via `import.meta.glob(..., {query:'?raw'})` and mapped to dotted
  `require` names in `src/sources.ts` (the browser analog of
  `loadFenTree`); the vendored Fennel compiler and cjson stub are bundled
  as raw text and passed to `createFenRuntime` so its Node-only `fs`
  readers never run in-page (see [../runtime/boot.md](../runtime/boot.md)).
- **#8 — sandboxed iframe preview + `preview.*` tools (implemented).**
  `preview.refresh` re-renders the IndexedDB tree into a sandboxed
  `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).
  `preview.query(selector)`, `preview.click(selector)`,
  `preview.fill(selector, value)`, `preview.eval(expr)` drive the running
  app via a `postMessage` RPC channel; `preview.screenshot` renders a
  canvas → dataURL. The RPC is the new `host.preview` primitive
  (`packages/bindings/src/preview`, [../bindings/preview.md](../bindings/preview.md));
  the page assembly (rendering the vfs tree, inlining same-tree
  stylesheet/script refs) and the six tools live in Fennel
  (`apps/demo/fnl/fen_web/demo/preview`), registered demo-only through the
  per-owner manifest loader (`fen_web.demo.boot.load-extension!` on
  `fen_web.demo.preview.manifest`) — the same path the file tools use, not
  an ad-hoc one. Like `host.fetch`, the RPC is asynchronous, so each tool
  starts/polls/yields the turn coroutine between polls rather than blocking.
- **#9 — starter project.** A curated starter todo app is seeded into the
  IndexedDB-backed vfs on first load (open question in fen#99: curated
  starter vs. boot empty — resolved in favor of seeding, so the
  preview-driving loop is demoable in one click). The starter files are
  real, reviewable source under `apps/demo/starter/` (`index.html` +
  `app.js` + `styles.css`); the browser bundles them to raw text via
  `import.meta.glob` (`src/starter.ts`) and `boot.ts` stages them into the
  VM, the same delivery shape as the vendored Fennel/fetch sources. Seeding
  itself is Fennel policy (`fen_web.demo.seed`, called from
  `fen_web.demo.boot`): the bytes are written into the `fs:` vfs keyspace
  through the ordinary `fen_web.tools.vfs` mechanism — no new persistence
  path. **Seed-once invariant:** `seed-if-empty!` writes only when the vfs
  is empty (a genuine first load), so a later load never clobbers user
  work. The seeded `/index.html` renders through the existing
  `preview.refresh`/`build-page` assembler out of the box (same-tree
  `styles.css`/`app.js` inlined). Coverage: `apps/demo/tests/seed_test.fnl`
  (first-load seeds, non-empty vfs untouched, seeded entry renders through
  `build-page`) and the end-to-end seed assertion in
  `apps/demo/src/bootTurn.test.ts`.

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
foreign-source rejection) and `apps/demo/tests/preview_test.fnl` (the page
assembler never emits the stored API key). See
[../bindings/preview.md](../bindings/preview.md).

See also: [../architecture/fennel-first.md](../architecture/fennel-first.md)
(`host.dom-apply` role), [extension.md](extension.md) for the other
delivery shape.
