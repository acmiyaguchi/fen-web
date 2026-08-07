import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, PROVIDERS, SettingsStore, type SettingsKv } from "./settings.js";

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

test("settings store round-trips OpenAI and OpenRouter keys and models", async () => {
  const kv = new MemorySettingsKv();
  const store = new SettingsStore("settings-provider-test", kv);

  assert.equal(PROVIDERS.find((provider) => provider.id === "openai")?.envVar, "OPENAI_API_KEY");
  assert.equal(
    PROVIDERS.find((provider) => provider.id === "openrouter")?.envVar,
    "OPENROUTER_API_KEY",
  );
  assert.equal(PROVIDERS.find((provider) => provider.id === "openai")?.browserDirect, true);
  assert.equal(PROVIDERS.find((provider) => provider.id === "openrouter")?.browserDirect, true);

  await store.setApiKey("OPENAI_API_KEY", "openai-secret");
  await store.setApiKey("OPENROUTER_API_KEY", "openrouter-secret");
  await store.setSelectedProvider("openrouter");
  await store.setSelectedModel("openrouter", "openai/gpt-5.4-nano");

  const afterReload = new SettingsStore("settings-provider-test", kv);
  assert.equal(await afterReload.getApiKey("OPENAI_API_KEY"), "openai-secret");
  assert.equal(await afterReload.getApiKey("OPENROUTER_API_KEY"), "openrouter-secret");
  assert.equal(await afterReload.getSelectedProvider(), "openrouter");
  assert.equal(await afterReload.getSelectedModel("openrouter"), "openai/gpt-5.4-nano");
  assert.equal(kv.values.get("env/apikey/OPENAI_API_KEY"), "openai-secret");
  assert.equal(kv.values.get("env/apikey/OPENROUTER_API_KEY"), "openrouter-secret");
  assert.deepEqual(MODEL_CATALOG.openai.map((model) => model.id), ["gpt-5.4-nano"]);
  assert.deepEqual(MODEL_CATALOG.openrouter.map((model) => model.id), [
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.4-nano",
  ]);
});

test("settings store rejects a model outside the provider catalog", async () => {
  const store = new SettingsStore("settings-test", new MemorySettingsKv());
  await assert.rejects(
    () => store.setSelectedModel("anthropic", "not-a-model"),
    /unknown model not-a-model for provider anthropic/,
  );
});
