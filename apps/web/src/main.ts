import "./styles.css";
import { PROVIDERS, SettingsStore, providerById } from "./settings.js";
import { bootDemoInBrowser, type DemoSession } from "./browserBoot.js";

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

  // Single source of truth for the running agent VM and its boot lifecycle.
  // A single-flight `booting` promise makes double-submit, submit-racing-
  // auto-start, and re-entrant boots all await the same VM instead of
  // spawning competing VMs/presenter loops against the same DOM + database.
  let session: DemoSession | undefined;
  let booting: Promise<DemoSession> | undefined;
  const selectedProvider = await store.getSelectedProvider();

  const showFatal = (err: unknown): void => {
    console.error("fen-web demo failed to start", err);
    settingsRoot.classList.remove("hidden");
    settingsRoot.replaceChildren();
    settingsRoot.append(
      el("p", { class: "settings-notice" }, `Failed to start: ${String(err)}`),
    );
  };

  // Boot exactly one VM. The key is already persisted to IndexedDB by the
  // caller; bootDemoInBrowser reads it from there (env/apikey/<VAR>) and
  // resolves it in-VM — no key is passed through here.
  const startSession = async (providerId: string): Promise<void> => {
    if (session || booting) {
      await booting;
      return;
    }
    booting = bootDemoInBrowser({ provider: providerId, dbName: DB_NAME });
    try {
      session = await booting;
      settingsRoot.classList.add("hidden");
    } finally {
      booting = undefined;
    }
  };

  // Stop and discard the running VM. Cooperative shutdown revokes the VM's
  // in-memory key snapshot: after this, no further turns can send the old
  // key, so "Forget key"/key-replacement actually take effect.
  const stopSession = async (): Promise<void> => {
    if (booting) await booting.catch(() => undefined);
    const s = session;
    session = undefined;
    if (s) await s.stop();
  };

  const renderSettings = async (): Promise<void> => {
    settingsRoot.replaceChildren();
    const provider = providerById(selectedProvider);
    // Keyless providers (empty envVar, e.g. openai-codex) authenticate via
    // dev-server-bridged OAuth creds — no key row, save just (re)starts.
    const needsKey = provider.envVar !== "";
    const existing = needsKey ? ((await store.getApiKey(provider.envVar)) ?? "") : "";
    const running = session !== undefined || booting !== undefined;

    const form = el("form", { class: "settings-form", id: "settings-form" });
    form.append(el("h1", {}, "fen-web demo"));

    // Provider selector; adding a provider here stays a settings-only change
    // once its boot registration is available.
    const providerRow = el("label", { class: "settings-row" }, "Provider");
    const select = el("select", { id: "provider-select" });
    for (const p of PROVIDERS) {
      const opt = el("option", { value: p.id }, p.label);
      if (p.id === selectedProvider) opt.setAttribute("selected", "selected");
      select.append(opt);
    }
    providerRow.append(select);
    form.append(providerRow);

    const input = el("input", {
      id: "api-key-input",
      type: "password",
      autocomplete: "off",
      placeholder: provider.id === "openai" ? "sk-…" : "sk-ant-…",
    });
    if (needsKey) {
      const keyRow = el("label", { class: "settings-row" }, `${provider.label} API key`);
      input.value = existing;
      keyRow.append(input);
      form.append(keyRow);
    }

    const notice = el(
      "p",
      { class: "settings-notice" },
      needsKey
        ? "Your key is stored only in this browser (IndexedDB) and is sent " +
            "directly to the provider's API — never to any fen-web server. " +
            "No key proxy exists. " +
            provider.note
        : provider.note,
    );
    form.append(notice);

    if (running) {
      form.append(
        el(
          "p",
          { class: "settings-notice" },
          "An agent session is running with the current key. Saving a new " +
            "key or forgetting the key will stop it and revoke that key.",
        ),
      );
    }

    const actions = el("div", { class: "settings-actions" });
    const save = el(
      "button",
      { type: "submit", class: "settings-save" },
      running ? "Save & restart" : "Save & start",
    );
    actions.append(save);
    if (needsKey && existing) {
      const clear = el("button", { type: "button", class: "settings-clear" }, "Forget key");
      clear.addEventListener("click", () => {
        void (async () => {
          try {
            // Revoke first (stop the running VM), then erase storage, so a
            // turn can't slip in between clearing and shutdown.
            await stopSession();
            await store.clearApiKey(provider.envVar);
            input.value = "";
            await renderSettings();
          } catch (err) {
            showFatal(err);
          }
        })();
      });
      actions.append(clear);
    }
    form.append(actions);

    select.addEventListener("change", () => {
      void (async () => {
        await store.setSelectedProvider(select.value);
        location.reload();
      })();
    });

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void (async () => {
        const key = input.value.trim();
        if (needsKey && !key) {
          notice.textContent = "Enter an API key to start.";
          return;
        }
        if (booting) return; // a boot is already in flight; ignore re-submit
        save.setAttribute("disabled", "disabled");
        try {
          if (needsKey) await store.setApiKey(provider.envVar, key);
          await store.setSelectedProvider(provider.id);
          // Replacing the key must revoke the old VM before a new one boots
          // with the new key snapshot.
          await stopSession();
          await startSession(provider.id);
        } catch (err) {
          showFatal(err);
        } finally {
          save.removeAttribute("disabled");
        }
      })();
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
  if (provider.envVar) {
    const existing = await store.getApiKey(provider.envVar);
    if (existing) await startSession(provider.id);
  } else if (import.meta.env.DEV) {
    // Keyless (openai-codex) is dev-only: only auto-start when the
    // dev-server auth bridge actually has credentials. This branch is
    // removed from production builds, where the provider is not offered.
    const bridged = await fetch("/__fen/codex-auth")
      .then((r) => r.ok)
      .catch(() => false);
    if (bridged) await startSession(provider.id);
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
