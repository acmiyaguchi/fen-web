# apps/demo

Planned. Issues #6-#9. Not yet implemented.

Self-contained single page: IndexedDB-backed virtual FS, sandboxed iframe
preview the agent can drive, BYO API key. No key-proxy infrastructure —
see the top-level [README.md](../../README.md) non-goals.

## Planned shape (by issue)

- **#6 — DOM presenter.** Reuses the compositional panel/fragment model
  from fen's TUI extension, driven via `host.dom-apply`. Replaces
  termbox2's rendering, not its composition model.
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
