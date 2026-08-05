# kv (`host.kv`)

Minimal async string-keyed/string-valued KV surface, the substrate for the
virtual FS. No filesystem semantics (paths, directories) live in TS — that
policy is Fennel, layered on top (planned, see
[../platform/tools.md](../platform/tools.md), issue #4). Status:
implemented, landed on `main` at commit `02f4b1a` (closes issue #3).

## HostKv interface

`packages/bindings/src/kv/types.ts`:

```ts
interface HostKv {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

`list` returns all keys with the given prefix in ascending lexicographic
order; empty prefix lists everything.

## Bridging: no poll pair (by design, for now)

Unlike fetch, KV operations are fast and don't stream, so this package
does not commit to a start/poll bridge. `packages/runtime` can either
resume the Lua coroutine synchronously once a KV promise settles, or drive
a `kv_start`/`kv_poll` pair mirroring `FetchPoller` for symmetry — the
decision is explicitly left to `packages/runtime`
(`packages/bindings/src/kv/types.ts:7-19`). See
[host-protocol.md](host-protocol.md) for why fetch needed the poll shape
in the first place (coroutine yield-across-C-call hazard).

## Implementations

- **`IndexedDbKv`** (`packages/bindings/src/kv/indexedDbKv.ts`) — single
  object store (`"kv"`) in a `fen-kv` database, string keys/values, raw
  IndexedDB API (no wrapper dependency, per the no-external-runtime-deps
  constraint). `list(prefix)` uses an `IDBKeyRange.bound(prefix, prefix +
  "￿")` cursor scan rather than enumerating the whole store.
- **`MemoryKv`** (`packages/bindings/src/kv/memoryKv.ts`) — in-memory stub
  for desktop Busted/Node tests, no browser required.
- **`SyncKvCache`** (`packages/bindings/src/kv/syncKvCache.ts`) — a
  *synchronous* view over an async `HostKv`, produced by loading the whole
  key space into memory once (`SyncKvCache.load`) and writing back
  asynchronously (`flush()` awaits durability). It exposes `sync = true`,
  the capability flag `fen_web.sessions` asserts before registering
  (see [../platform/shims.md](../platform/shims.md)). This is the demo
  shell's answer (issue #7) to the sync-over-async gap below: fen's
  kv-backed seams (`kv_session`, `fs_kv`) call get/put/delete/list
  synchronously, and a single-page, single-VM app can just mirror the
  store rather than build the streaming coroutine bridge. It is not
  multi-tab-coherent; when that matters, the coroutine bridge below
  supersedes it (the `sync = true` contract is the same either way).

## Consumers (planned)

Virtual FS (issue #4), IndexedDB session backend (issue #14, see
[../platform/sessions.md](../platform/sessions.md)), and the settings/
model-key shims (issue #15, see [../platform/shims.md](../platform/shims.md))
all sit on top of `host.kv`.

See also: [host-protocol.md](host-protocol.md),
[../architecture/seams.md](../architecture/seams.md).
