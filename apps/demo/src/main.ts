import { PROVIDERS, SettingsStore, providerById } from "./settings.js";
import { bootDemo, type DemoSession } from "./boot.js";

// The single-page shell's chrome: a BYO-key settings gate plus the
// `#fen-app` mount the Fennel DOM presenter renders into. Everything the
// agent shows lives in Fennel (the presenter); this file is only the shell
// gate — the litmus test's "HTML shell" TS (docs/architecture/fennel-first.md).

const DB_NAME = "fen-web-demo";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main(): Promise<void> {
  const store = new SettingsStore(DB_NAME);
  const settingsRoot = document.getElementById("fen-settings");
  const appRoot = document.getElementById("fen-app");
  const openButton = document.getElementById("fen-open-settings");
  if (!settingsRoot || !appRoot || !openButton) {
    throw new Error("fen-web demo: shell markup is missing required elements");
  }

  let session: DemoSession | undefined;
  const selectedProvider = await store.getSelectedProvider();

  const renderSettings = async (): Promise<void> => {
    settingsRoot.replaceChildren();
    const provider = providerById(selectedProvider);
    const existing = (await store.getApiKey(provider.envVar)) ?? "";

    const form = el("form", { class: "settings-form", id: "settings-form" });
    form.append(el("h1", {}, "fen-web demo"));

    // Provider selector (single option today; select keeps the seam open).
    const providerRow = el("label", { class: "settings-row" }, "Provider");
    const select = el("select", { id: "provider-select" });
    for (const p of PROVIDERS) {
      const opt = el("option", { value: p.id }, p.label);
      if (p.id === selectedProvider) opt.setAttribute("selected", "selected");
      select.append(opt);
    }
    providerRow.append(select);
    form.append(providerRow);

    const keyRow = el("label", { class: "settings-row" }, `${provider.label} API key`);
    const input = el("input", {
      id: "api-key-input",
      type: "password",
      autocomplete: "off",
      placeholder: "sk-ant-…",
    });
    input.value = existing;
    keyRow.append(input);
    form.append(keyRow);

    const notice = el(
      "p",
      { class: "settings-notice" },
      "Your key is stored only in this browser (IndexedDB) and is sent " +
        "directly to the provider's API — never to any fen-web server. " +
        "No key proxy exists. " +
        provider.note,
    );
    form.append(notice);

    const actions = el("div", { class: "settings-actions" });
    const save = el("button", { type: "submit", class: "settings-save" }, "Save & start");
    actions.append(save);
    if (existing) {
      const clear = el("button", { type: "button", class: "settings-clear" }, "Forget key");
      clear.addEventListener("click", async () => {
        await store.clearApiKey(provider.envVar);
        input.value = "";
      });
      actions.append(clear);
    }
    form.append(actions);

    select.addEventListener("change", async () => {
      await store.setSelectedProvider(select.value);
      location.reload();
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const key = input.value.trim();
      if (!key) {
        notice.textContent = "Enter an API key to start.";
        return;
      }
      await store.setApiKey(provider.envVar, key);
      await store.setSelectedProvider(provider.id);
      settingsRoot.classList.add("hidden");
      if (!session) {
        session = await bootDemo({ apiKey: key, provider: provider.id, dbName: DB_NAME });
      }
    });

    settingsRoot.append(form);
  };

  openButton.addEventListener("click", () => {
    settingsRoot.classList.remove("hidden");
    void renderSettings();
  });

  await renderSettings();

  // Auto-start when a key is already present so a returning user lands
  // straight in the agent UI; the gate stays reachable via the button.
  const provider = providerById(selectedProvider);
  const existing = await store.getApiKey(provider.envVar);
  if (existing) {
    settingsRoot.classList.add("hidden");
    session = await bootDemo({ apiKey: existing, provider: provider.id, dbName: DB_NAME });
  }

  // Persist session write-backs on unload (best-effort durability).
  window.addEventListener("beforeunload", () => {
    void session?.flush();
  });
}

void main().catch((err) => {
  console.error("fen-web demo failed to start", err);
  const root = document.getElementById("fen-settings");
  if (root) {
    root.classList.remove("hidden");
    root.replaceChildren();
    root.append(el("p", { class: "settings-notice" }, `Failed to start: ${String(err)}`));
  }
});
