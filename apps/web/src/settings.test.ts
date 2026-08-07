import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, SettingsStore, type SettingsKv } from "./settings.js";

class MemorySettingsKv implements SettingsKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("settings store persists a model independently for each provider", async () => {
  const kv = new MemorySettingsKv();
  const first = new SettingsStore("settings-test", kv);

  assert.equal(await first.getSelectedModel("anthropic"), "claude-haiku-4-5");
  await first.setSelectedModel("anthropic", "claude-sonnet-5");

  // A new store instance represents a reload while retaining the same durable
  // key/value backend.
  const afterReload = new SettingsStore("settings-test", kv);
  assert.equal(await afterReload.getSelectedModel("anthropic"), "claude-sonnet-5");
  assert.deepEqual(MODEL_CATALOG["openai-codex"]?.map((model) => model.id), [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);
  assert.equal(
    await afterReload.getSelectedModel("does-not-exist").catch((error: unknown) => String(error)),
    'Error: fen-web demo: unknown provider does-not-exist',
  );
});

test("settings store rejects a model outside the provider catalog", async () => {
  const store = new SettingsStore("settings-test", new MemorySettingsKv());
  await assert.rejects(
    () => store.setSelectedModel("anthropic", "not-a-model"),
    /unknown model not-a-model for provider anthropic/,
  );
});
