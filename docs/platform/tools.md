# Virtual FS + tools

The browser extension is implemented in
`packages/platform/fnl/fen_web/tools/` and loaded by the web boot through
`fen_web.tools.manifest`. It registers browser-native tools through the
ordinary public `api.register :tool` kind; no core/runtime change is needed.
All registered tools use fen's canonical
`{:content [{:type :text :text ...}] :is-error? bool}` result shape. The
small core workspace set is `:always` exposed; specialized browser tools are
`:search` exposed and are activated through `tool_search`.

## Registered tools

| Tool | Exposure | Contract |
| --- | --- | --- |
| `read`, `write`, `edit`, `grep`, `find`, `ls`, `delete`, `move` | always | Browser-native workspace tools over `host.kv`. Their schemas and result conventions mirror fen. Relative paths resolve against the tool context `cwd`; otherwise the virtual filesystem root is `/`. |
| `tool_search` | always | Registry-generic port of fen's builtin tool search. It searches `ctx.agent.tools` for `:search`-exposed contributions and records activations in `agent.active-tool-names`; it does not depend on desktop-only process/filesystem infrastructure. |
| `fennel_eval` | search | Evaluates one Fennel expression in the same Wasmoon VM using a fresh scratch environment. Standard math/string/table helpers and an explicit `host.vfs` facade over `host.kv` support calculations and batch VFS operations. Its result is JSON text; syntax errors, runtime errors, non-serializable values, and oversized results are clean tool errors. |
| `web_fetch` | search (opt-in) | Fetches an HTTP(S) URL through the existing `host.fetch_start`/`fetch_poll`/`fetch_dispose` seam. It is registered only when the web boot option `enableWebFetch` is explicitly `true`; the default is false. The host keeps a bounded head and the tool returns at most about 50KB, framed as untrusted web content. |
| `preview_refresh`, `preview_query`, `preview_click`, `preview_fill`, `preview_eval`, `preview_screenshot` | search | Demo-only preview tools are activated through `tool_search`; `preview_console`, if present, remains `always` as the debugging lifeline. |

`cwd` is also the base for relative tool paths when the agent supplies it in
tool context. The virtual filesystem itself is rooted at `/` (the whole VFS is
the workspace in the web app); `..` traversal that would escape `/` is
rejected by `vfs.normalize`. A host may additionally supply an optional
`ctx.workspace-root` boundary for mutating operations, but the tools do not
promise a narrower root by default.

## Fennel eval trust model and result boundary

`fennel_eval` is a capability escape hatch, not a security sandbox. The agent
already controls executable code in the Wasmoon VM, so enabling evaluation does
not create a new trust boundary. Each call nevertheless gets a new scratch
environment: assignments do not persist between calls, and fen registries,
agent state, `require`, process/filesystem globals, and raw `__fen_host` are not
ambient names. The deliberate host capability is `host.vfs`, a small facade
backed by `host.kv` that exposes normalized read/write/delete/list/walk
operations without exposing the raw host table. User coroutines are not
exposed because they could consume the tool pump's cooperative yield.

Every eval result is encoded with fen's JSON seam before it becomes tool text,
including strings and `nil` (`null`). Functions, userdata, cycles, and other
values that cjson cannot encode are returned as clean tool errors. The optional
`max_bytes` limit rejects oversized output rather than truncating it into
invalid JSON; obvious oversized strings and tables are rejected before cjson
materializes the complete result. This preserves the host-protocol rule that
no Wasmoon proxy userdata or executable value crosses into a tool result. The
single value consumed from an expression is encoded, so extra return values
from `(values ...)` are dropped.

## Web-fetch decision and safety

`web_fetch` is deliberately gated off by default because browser-direct
requests only work when the target sends permissive CORS headers. Many useful
sites will therefore fail from a page even though they are reachable from a
server-side client. The response is also untrusted web content: pages can
contain prompt-injection text that attempts to redirect the agent. The tool
description tells the model to treat fetched text as data, not instructions;
callers should enable it only when that capability is wanted. Its body is
wrapped in explicit untrusted-content framing, while HTTP status and headers
remain outside that frame.

The flag is plumbed without a UI: `DemoBootOptions.enableWebFetch` is staged
as `__demo_opts["enable-web-fetch"]`, and `fen_web.web.boot` passes the boot
options into the tools extension registration. No flag means no registered
`web_fetch` schema.

## Virtual filesystem

fen has no filesystem seam to fill: its builtin `read`/`edit`/`write`/`find`/
`grep`/`ls` tools call `io.open`/`io.popen`/`os.execute` directly. The web
extension instead layers path/tree semantics over
[`host.kv`](../bindings/kv.md): `fs:`-prefixed keys, normalized paths, file /
directory shadowing rejected, and path traversal blocked. Directories are
implicit key prefixes; an empty directory cannot exist.

`glob.fnl` implements the deliberately small `*`/`?` matcher used internally
by `find` and `grep`; `glob` is not registered as a second file-locating tool.
`grep.fnl` uses Lua patterns rather than full regex or ripgrep syntax.
`truncate.fnl` is an internal output helper, not a model-facing tool, and
cannot spill to a local file because browser Fennel has no local filesystem
equivalent.

## Reload manifest

The tool manifest's `reload-modules` includes the VFS helpers, internal
matcher/truncation helpers, all registered tool modules, `path_ops`,
`tool_search`, and `web_fetch`. Reloading the extension retains the last
registration options: callers that omit `enable-web-fetch` after an explicit
opt-in do not silently lose the tool. The normal workspace set is re-registered
with the same exposure policy.

See also: [host protocol](../bindings/host-protocol.md),
[fetch binding](../bindings/fetch.md), [sessions](sessions.md), and
[apps/web](../apps/web.md).
