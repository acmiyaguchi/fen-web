import { IndexedDbKv } from "@fen-web/bindings";

/**
 * BYO-key settings storage. Keys live in IndexedDB under the same path the
 * `fs_kv` shim maps `os.getenv("<VAR>")` to (`env/apikey/<VAR>`, see
 * docs/platform/shims.md), so an in-VM `models.json` apiKey env-var
 * reference resolves through the exact seam the desktop provider uses.
 *
 * The key never leaves the browser: it is written to IndexedDB here and, at
 * runtime, sent only in the provider request's auth header (directly to the
 * provider's API — there is no fen-web server). No key-proxy is a hard
 * non-goal (README).
 */

export interface ProviderChoice {
  id: string;
  label: string;
  /** Env-var name fen resolves the key under (kv path `env/apikey/<var>`). */
  envVar: string;
  /** Whether the demo can call this provider directly from the page today. */
  browserDirect: boolean;
  note: string;
}

/**
 * Provider order per docs/apps/demo.md: Anthropic is wired first because
 * api.anthropic.com accepts direct-from-page calls (the fetch backend adds
 * `anthropic-dangerous-direct-browser-access`). OpenAI-compatible endpoints
 * (incl. OpenRouter) come as their provider extensions land here.
 */
export const PROVIDERS: ProviderChoice[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    envVar: "ANTHROPIC_API_KEY",
    browserDirect: true,
    note: "Direct browser access via anthropic-dangerous-direct-browser-access.",
  },
  // Dev-server only: the auth bridge and /__codex-proxy exist only under
  // `vite dev`, so don't offer a dead-end provider in production builds.
  ...(import.meta.env.DEV
    ? [
        {
          id: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
    // No BYO key: OAuth creds come from the local fen CLI's
    // ~/.config/fen/auth.json, bridged by the Vite dev server
    // (/__fen/codex-auth) and seeded into the VM's kv auth path.
    envVar: "",
    browserDirect: false,
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

function kvPath(envVar: string): string {
  return `env/apikey/${envVar}`;
}

export function providerById(id: string): ProviderChoice {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`fen-web demo: unknown provider ${id}`);
  return p;
}

/** Storage-only surface over IndexedDB, kept separate from the DOM so it is
 * unit-testable and reusable (e.g. by the extension form later). */
export class SettingsStore {
  private kv: IndexedDbKv;

  constructor(dbName: string = DB_NAME) {
    this.kv = new IndexedDbKv(dbName);
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
}
