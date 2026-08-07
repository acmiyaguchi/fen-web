import { IndexedDbKv } from "@fen-web/bindings";

/**
 * BYO-key settings storage. Keys live in IndexedDB under `env/apikey/<VAR>`,
 * the path the runtime's `fen.util.path.backend` stub reads for in-VM
 * `path.getenv("<VAR>")` (see packages/runtime/src/stubs.ts and
 * docs/platform/shims.md), so an in-VM `models.json` apiKey env-var
 * reference resolves through the exact seam the desktop provider uses.
 *
 * The key never leaves the browser: it is written to IndexedDB here and, at
 * runtime, sent only in the provider request's auth header (directly to the
 * provider's API — there is no fen-web server). No key-proxy is a hard
 * non-goal (README).
 */

export interface ModelChoice {
  /** Request max_tokens for this model. Adaptive-thinking models (Sonnet/
   * Opus 5) spend thinking against the cap, so they need far more headroom
   * than Haiku; the Fennel boot falls back to 8192 when absent. */
  maxTokens?: number;
  id: string;
  label: string;
  /** The provider's conservative built-in default. */
  default: boolean;
}

/**
 * The browser settings gate intentionally uses a curated catalog rather than
 * the runtime's dynamic catalog event. Keep provider model ids in this one
 * place so the UI and its defaulting logic cannot drift apart.
 */
// Keep provider ids here aligned with SUPPORTED-PROVIDERS in
// apps/web/fnl/fen_web/web/boot.fnl: this TypeScript catalog controls what the
// settings gate can select, while the Fennel set controls what the VM wires.
export const MODEL_CATALOG: Readonly<Record<string, readonly ModelChoice[]>> = {
  anthropic: [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", default: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", default: false, maxTokens: 32000 },
    { id: "claude-opus-5", label: "Claude Opus 5", default: false, maxTokens: 32000 },
  ],
  // Fen's plain OpenAI provider documents gpt-5.4-nano as its default
  // Chat Completions model (fen/docs/providers.md and provider_help.fnl).
  openai: [
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano", default: true, maxTokens: 8192 },
  ],
  // OpenRouter has no static catalog in Fen v0.17. These namespaced IDs are
  // best-effort examples; a 404 costs no completion, and the provider's live
  // model catalog remains authoritative. gpt-5.4-nano is grounded by the
  // plain OpenAI catalog and avoids shipping the likely-404 Codex-adjacent
  // gpt-5.5 id here.
  openrouter: [
    {
      id: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5 (OpenRouter)",
      default: true,
      maxTokens: 8192,
    },
    { id: "openai/gpt-5.4-nano", label: "GPT-5.4 nano (OpenRouter)", default: false, maxTokens: 8192 },
  ],
  // The Codex provider is offered only by the dev server. These are the
  // stable ids already pinned by fen's Codex provider extension.
  "openai-codex": [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", default: true },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", default: false },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", default: false },
  ],
};

export interface ProviderChoice {
  id: string;
  label: string;
  /** Env-var name fen resolves the key under (kv path `env/apikey/<var>`). */
  envVar: string;
  /** Whether the demo can call this provider directly from the page today. */
  browserDirect: boolean;
  /** Models shown by the settings gate for this provider. */
  models: readonly ModelChoice[];
  note: string;
}

/**
 * Provider order per docs/apps/web.md: Anthropic is wired first because
 * api.anthropic.com accepts direct-from-page calls (the fetch backend adds
 * `anthropic-dangerous-direct-browser-access`). OpenAI and OpenRouter use
 * Fen's shared Chat Completions adapter with provider-specific base URLs.
 */
const isDevBuild = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;

export const PROVIDERS: ProviderChoice[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    envVar: "ANTHROPIC_API_KEY",
    browserDirect: true,
    models: MODEL_CATALOG.anthropic,
    note: "Direct browser access via anthropic-dangerous-direct-browser-access.",
  },
  {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    browserDirect: true,
    models: MODEL_CATALOG.openai,
    note: "Browser-direct CORS preflight accepted by api.openai.com (probe 2026-08-07).",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    browserDirect: true,
    models: MODEL_CATALOG.openrouter,
    note:
      "Browser-direct CORS is supported by openrouter.ai; HTTP-Referer/X-Title " +
      "headers are unavailable in pinned Fen v0.17 (fen#492).",
  },
  // Dev-server only: the auth bridge and /__codex-proxy exist only under
  // `vite dev`, so don't offer a dead-end provider in production builds.
  ...(isDevBuild
    ? [
        {
          id: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          // No BYO key: OAuth creds come from the local fen CLI's
          // ~/.config/fen/auth.json, bridged by the Vite dev server
          // (/__fen/codex-auth) and seeded into the VM's kv auth path.
          envVar: "",
          browserDirect: false,
          models: MODEL_CATALOG["openai-codex"],
          note:
            "Dev-server only: uses the local fen CLI's Codex OAuth login " +
            "(run `fen --login openai-codex` first); requests relay through " +
            "the Vite /__codex-proxy.",
        },
      ]
    : []),
];

const DB_NAME = "fen-web-demo";
const SELECTED_PROVIDER_KEY = "settings/selected-provider";

function selectedModelKey(providerId: string): string {
  return `settings/selected-model/${providerId}`;
}

function kvPath(envVar: string): string {
  return `env/apikey/${envVar}`;
}

export function providerById(id: string): ProviderChoice {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`fen-web demo: unknown provider ${id}`);
  return p;
}

export interface SettingsKv {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function defaultModelForProvider(providerId: string): string {
  const provider = providerById(providerId);
  return provider.models.find((model) => model.default)?.id ?? provider.models[0].id;
}

export class SettingsStore {
  private kv: SettingsKv;

  constructor(dbName: string = DB_NAME, kv?: SettingsKv) {
    this.kv = kv ?? new IndexedDbKv(dbName);
  }

  async getApiKey(envVar: string): Promise<string | undefined> {
    return this.kv.get(kvPath(envVar));
  }

  async setApiKey(envVar: string, key: string): Promise<void> {
    await this.kv.put(kvPath(envVar), key);
  }

  async clearApiKey(envVar: string): Promise<void> {
    await this.kv.delete(kvPath(envVar));
  }

  async getSelectedProvider(): Promise<string> {
    return (await this.kv.get(SELECTED_PROVIDER_KEY)) ?? PROVIDERS[0].id;
  }

  async setSelectedProvider(id: string): Promise<void> {
    await this.kv.put(SELECTED_PROVIDER_KEY, id);
  }

  async getSelectedModel(providerId: string): Promise<string> {
    const fallback = defaultModelForProvider(providerId);
    const stored = await this.kv.get(selectedModelKey(providerId));
    const provider = providerById(providerId);
    return stored && provider.models.some((model) => model.id === stored) ? stored : fallback;
  }

  async setSelectedModel(providerId: string, modelId: string): Promise<void> {
    const provider = providerById(providerId);
    if (!provider.models.some((model) => model.id === modelId)) {
      throw new Error(`fen-web demo: unknown model ${modelId} for provider ${providerId}`);
    }
    await this.kv.put(selectedModelKey(providerId), modelId);
  }
}
