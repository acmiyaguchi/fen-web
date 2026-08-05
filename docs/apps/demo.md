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
- **#7 — shell + BYO-key settings.** Single-page shell; API keys stored in
  IndexedDB, never leave the browser. Provider order: OpenAI-compatible
  endpoints first (`api.openai.com` accepts direct browser calls with a
  bearer key; OpenRouter is the likely servicing basis — one key, many
  models, CORS-open); Anthropic supported via
  `anthropic-dangerous-direct-browser-access` but not the default.
  Settings persistence is part of the shim work in
  [../platform/shims.md](../platform/shims.md) (`core/settings.fnl`,
  `core/llm/models.fnl`).
- **#8 — sandboxed iframe preview + `preview.*` tools.** `preview.refresh`
  re-renders the IndexedDB tree into a sandboxed
  `<iframe sandbox="allow-scripts">`. `preview.query(selector)`,
  `preview.click(selector)`, `preview.fill(selector, value)`,
  `preview.eval(expr)` drive the running app via `postMessage` RPC.
  `preview.screenshot` renders canvas → dataURL.
- **#9 — starter project.** A curated starter project seeded into
  IndexedDB on first load (open question in fen#99: curated starter vs.
  boot empty).

## Sandboxing invariant

The preview iframe runs with `sandbox="allow-scripts"` only — **no**
`allow-same-origin`. Agent tools reach it exclusively through the
`postMessage` RPC channel. User-generated JS in the preview cannot reach
the parent frame's virtual FS, the API key, or any forge token. This
invariant is load-bearing for BYO-key safety and must not be relaxed to
fix a preview capability gap — widen the RPC surface instead.

See also: [../architecture/fennel-first.md](../architecture/fennel-first.md)
(`host.dom-apply` role), [extension.md](extension.md) for the other
delivery shape.
