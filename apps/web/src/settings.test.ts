import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, providerById } from "./settings.js";

test("PROVIDERS exposes the browser-direct OpenAI BYO-key entry", () => {
  const openai = providerById("openai");
  assert.deepEqual(openai, {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    browserDirect: true,
    note: "Direct browser access to api.openai.com; no fen-web key proxy is used.",
  });
  assert.equal(PROVIDERS[0].id, "anthropic");
  assert.ok(PROVIDERS.some((provider) => provider.id === "openai"));
});

test("providerById rejects unknown providers", () => {
  assert.throws(() => providerById("missing"), /unknown provider missing/);
});
