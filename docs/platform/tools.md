# Virtual FS + tools

Planned. [Issue #4](https://github.com/acmiyaguchi/fen-web/issues/4). Not
yet implemented.

## No FS seam in fen

fen has no filesystem abstraction to fill: the builtin
read/edit/write/find/grep/ls tools call `io.open`/`io.popen`/
`os.execute` directly
(`fen/extensions/behaviors/kernel/builtin-tools/`). There is nothing to
swap.

## Approach

Do **not** load the `builtin-tools` extension in the browser. Instead
register browser-native file tools under the same names as an ordinary
extension, via `api.register :tool` (a public register kind — no core
change needed, and consistent with fen treating builtins as
POSIX-oriented). Reference:
`fen/packages/core/src/fen/core/extensions/register/tool.fnl` and
`fen/docs/extensions.md` (`fen/` repo docs, not this repo's).

## Tool spec shape

```
{:name ... :description ... :parameters <JSONSchema> :exposure ...
 :execute (fn [args ctx ?yield-fn] -> {:content [...] :is-error? ...})}
```

## Layering

Virtual-FS path/tree semantics (paths, directory structure, file
contents) live in Fennel beneath these tools, over
[`host.kv`](../bindings/kv.md). Sessions, skills, and extensions all load
from this FS without any fen core changes — this is the shared substrate
that #14 (sessions) also depends on.

Depends on: [host.kv](../bindings/kv.md) (issue #3, implemented),
[runtime boot](../runtime/boot.md) (issue #1). Testable on desktop against
the stub `host.kv` (`MemoryKv`) with Busted.

See also: [../architecture/seams.md](../architecture/seams.md),
[sessions.md](sessions.md).
