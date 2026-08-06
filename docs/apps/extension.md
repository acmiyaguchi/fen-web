# apps/extension

Deferred. Trails the demo; see
[issue #11](https://github.com/acmiyaguchi/fen-web/issues/11) (tracking
only, no design work yet) and
[fen#100](https://github.com/acmiyaguchi/fen/issues/100) for the extension
form's own tracking issue.

## Planned shape

MV3 browser extension: cross-origin fetch and real tab/DOM access via a
background service worker and content scripts, sharing the same fen core
and the same demo-side tool/platform layers
([../platform/tools.md](../platform/tools.md),
[../platform/sessions.md](../platform/sessions.md)) where they don't
depend on browser-only APIs.

Extension-only host primitives (not yet implemented; see
[../architecture/fennel-first.md](../architecture/fennel-first.md)):

- `host.msg` — `chrome.runtime` messaging between service worker and
  content scripts.
- `host.ext` — guarded proxy to specific `chrome.*` namespaces.

Extension-only tools sketched in fen#99: `browse(url)` (cross-origin fetch
via background worker), `tab.read`/`tab.click`/`tab.fill` (content-script
DOM access), `tabs.list`/`tabs.open`. Auth uses
`chrome.storage` instead of IndexedDB for keys, and
`chrome.identity.launchWebAuthFlow` for OAuth redirects instead of the
demo's device-flow polling.

## Known complication: MV3 service worker lifecycle

Service workers get killed and restarted on events. Long-running agent
state must checkpoint to storage and resume. fen's persistent-state-module
split (`fen.extensions.tui.state`, `fen.core.extensions.state`,
`fen.main`) is expected to map onto this without core changes, but this
hasn't been verified against actual MV3 kill/restart behavior yet.

## Status

No code, no detailed design beyond the fen#99 sketch. Do not build against
this page as a contract — it records intent only. See
[web.md](web.md) for the shape that ships first.
