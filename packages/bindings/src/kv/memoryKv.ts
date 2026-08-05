import type { HostKv } from "./types.js";

/** Map-based in-memory implementation of HostKv, for tests and Node
 * environments without IndexedDB. Same interface/semantics as
 * IndexedDbKv (ascending lexicographic prefix listing). */
export class MemoryKv implements HostKv {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    keys.sort();
    return keys;
  }
}
