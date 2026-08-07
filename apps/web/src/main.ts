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
  const appMount = appRoot;

  // Single source of truth for the running agent VM and its boot lifecycle.
  // A single-flight `booting` promise makes double-submit, submit-racing-
  // auto-start, and re-entrant boots all await the same VM instead of
  // spawning competing VMs/presenter loops against the same DOM + database.
  let session: DemoSession | undefined;
  let booting: Promise<DemoSession> | undefined;
  let selectedProvider = "anthropic";
  let fatalVisible = false;
  let noticeVisible = false;
  let fatalHandling = false;
  let globalErrorHandling = false;
  let restarting = false;
  let restartButton: HTMLButtonElement | undefined;
  let bootGeneration = 0;
  const STOP_TIMEOUT_MS = 3000;

  const updateRestartButton = (): void => {
    if (!restartButton) return;
    if (restarting) {
      restartButton.disabled = true;
      restartButton.textContent = "Restarting…";
    } else {
      restartButton.disabled = false;
      restartButton.textContent = "Restart";
    }
  };

  const errorDetails = (err: unknown): { message: string; stack?: string } => {
    if (err instanceof Error) return { message: err.message, stack: err.stack };
    if (typeof err === "string") return { message: err };
    if (err && typeof err === "object") {
      const value = err as { message?: unknown; stack?: unknown };
      return {
        message: typeof value.message === "string" ? value.message : String(err),
        ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
      };
    }
    return { message: String(err) };
  };

  const showFatal = (err: unknown): void => {
    const details = errorDetails(err);
    console.error("fen-web demo fatal error", err);
    fatalVisible = true;
    noticeVisible = false;
    settingsRoot.classList.remove("hidden");
    settingsRoot.replaceChildren();
    const panel = el("section", { class: "fatal-panel", role: "alert" });
    panel.append(el("h1", {}, "fen-web stopped"));
    panel.append(el("p", { class: "fatal-message" }, details.message));
    if (details.stack) panel.append(el("pre", { class: "fatal-stack" }, details.stack));
    const restart = el("button", { type: "button", class: "fatal-restart" }, "Restart");
    restartButton = restart;
    restart.addEventListener("click", () => void restartSession());
    updateRestartButton();
    panel.append(restart);
    settingsRoot.append(panel);
  };

  const showUnexpectedPageError = (err: unknown, preserveSettings = false): void => {
    if (noticeVisible) return;
    const details = errorDetails(err);
    console.error("fen-web demo unexpected page error", err);
    noticeVisible = true;
    settingsRoot.classList.remove("hidden");
    if (preserveSettings) {
      const form = settingsRoot.querySelector<HTMLElement>("#settings-form");
      (form ?? settingsRoot).append(
        el(
          "p",
          { class: "settings-notice", role: "alert" },
          `An unexpected page error occurred: ${details.message}`,
        ),
      );
      return;
    }
    settingsRoot.replaceChildren();
    const panel = el("section", { class: "fatal-panel", role: "alert" });
    panel.append(el("h1", {}, "fen-web noticed a page error"));
    panel.append(
      el(
        "p",
        { class: "fatal-message" },
        "An unexpected page error occurred. The agent session is still running.",
      ),
    );
    if (details.message) panel.append(el("p", { class: "settings-notice" }, details.message));
    if (details.stack) panel.append(el("pre", { class: "fatal-stack" }, details.stack));

    const actions = el("div", { class: "settings-actions" });
    const dismiss = el("button", { type: "button", class: "settings-clear" }, "Dismiss");
    dismiss.addEventListener("click", () => {
      noticeVisible = false;
      restartButton = undefined;
      settingsRoot.replaceChildren();
      settingsRoot.classList.add("hidden");
    });
    actions.append(dismiss);
    const restart = el("button", { type: "button", class: "fatal-restart" }, "Restart");
    restartButton = restart;
    restart.addEventListener("click", () => void restartSession());
    updateRestartButton();
    actions.append(restart);
    panel.append(actions);
    settingsRoot.append(panel);
  };

  // VM/run-loop failures are already closed and flushed by boot.ts, so this
  // path only renders the fatal panel. Explicit shell-operation failures also
  // use this path and are torn down before they are shown.
  const handleFatal = async (err: unknown, vmAlreadyClosed = false): Promise<void> => {
    if (fatalVisible || fatalHandling) return;
    fatalHandling = true;
    // Invalidate a startSession continuation that is awaiting this boot. The
    // in-VM boot can report fatal before bootDemo's promise continuation gets
    // to assign its (already closed) session.
    bootGeneration += 1;
    const current = session;
    const pendingBoot = booting;
    session = undefined;
    try {
      if (!vmAlreadyClosed && current) {
        try {
          await current.flush();
        } catch (flushErr) {
          console.error("fen-web demo: fatal-error flush failed", flushErr);
        }
        try {
          await current.stop();
        } catch (stopErr) {
          console.error("fen-web demo: fatal-error teardown failed", stopErr);
        }
      } else if (!vmAlreadyClosed && pendingBoot) {
        // Let an in-flight browser assembly finish its own cleanup/error path;
        // it has no session to flush until bootDemo resolves. Do not let a
        // blocked browser boot hold the fatal latch forever.
        await settleWithin(
          pendingBoot.then(() => undefined, () => undefined),
          STOP_TIMEOUT_MS,
        );
      }
      // A newer healthy session or an earlier fatal owns the panel now.
      if (!fatalVisible && (!session || session === current)) showFatal(err);
    } finally {
      fatalHandling = false;
    }
  };

  // A page-level error is not evidence that the VM is broken. In particular,
  // do not flush/stop a live session here: unrelated UI or browser warnings
  // must not destroy the user's agent. During boot, wait for that exact boot
  // to settle before deciding whether there is a live session to preserve.
  const handleGlobalError = async (err: unknown): Promise<void> => {
    if (fatalVisible || globalErrorHandling) return;
    globalErrorHandling = true;
    const pendingBoot = booting;
    const generation = bootGeneration;
    try {
      if (pendingBoot) {
        let booted: DemoSession | undefined;
        let bootFailed = false;
        let bootError: unknown;
        const bootResult = await settleWithin(
          pendingBoot.then(
            (value) => {
              booted = value;
            },
            (error) => {
              bootFailed = true;
              bootError = error;
            },
          ),
          STOP_TIMEOUT_MS,
        );
        if (fatalVisible || generation !== bootGeneration) return;
        if (!bootResult.completed) {
          showFatal(new Error("fen-web demo: boot did not settle while handling a page error"));
          return;
        }
        if (bootFailed) {
          showFatal(bootError);
          return;
        }
        // Usually startSession assigns this before this continuation runs.
        // The guarded fallback closes the small promise-continuation race
        // without stealing a newer boot started after this one.
        if (!session && booting === pendingBoot && booted) session = booted;
      }
      if (fatalVisible) return;
      if (session) showUnexpectedPageError(err);
      else showUnexpectedPageError(err, true);
    } finally {
      globalErrorHandling = false;
    }
  };

  // Composable listeners: do not clobber another page consumer's onerror.
  window.addEventListener("error", (event) => {
    // Resource-load errors (for example a 404 image/script) have no Error
    // object and are not evidence that the VM or page failed.
    if (!event.error) return;
    void handleGlobalError(event.error);
  });
  window.addEventListener("unhandledrejection", (event) => {
    void handleGlobalError(event.reason);
  });

  selectedProvider = await store.getSelectedProvider();

  // Boot exactly one VM. The key is already persisted to IndexedDB by the
  // caller; bootDemoInBrowser reads it from there (env/apikey/<VAR>) and
  // resolves it in-VM — no key is passed through here.
  const startSession = async (providerId: string): Promise<void> => {
    if (session) return;
    if (booting) {
      await booting;
      return;
    }
    fatalVisible = false;
    noticeVisible = false;
    // A fresh VM starts with an empty committed DOM model. Remove the old
    // presenter's nodes before its first create batch, or duplicate ids make
    // browser getElementById target the dead VM's nodes.
    appMount.replaceChildren();
    const generation = ++bootGeneration;
    const pending = (booting = bootDemoInBrowser({
      provider: providerId,
      dbName: DB_NAME,
      onFatal: (err) => handleFatal(err, true),
    }));
    try {
      const booted = await pending;
      if (fatalVisible || generation !== bootGeneration) {
        // A fatal callback may have closed this VM while this continuation was
        // still queued. Do not resurrect it as the live session.
        await booted.close();
        return;
      }
      session = booted;
      if (!fatalVisible) settingsRoot.classList.add("hidden");
    } finally {
      if (booting === pending) booting = undefined;
    }
  };

  const hasStartCredential = async (providerId: string): Promise<boolean> => {
    const provider = providerById(providerId);
    if (provider.envVar) return Boolean(await store.getApiKey(provider.envVar));
    if (!import.meta.env.DEV) return false;
    return fetch("/__fen/codex-auth")
      .then((res) => res.ok)
      .catch(() => false);
  };

  const settleWithin = async (
    operation: Promise<void>,
    timeoutMs: number,
  ): Promise<{ completed: boolean; error?: unknown }> =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ completed: false });
      }, timeoutMs);
      operation.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ completed: true });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ completed: true, error });
        },
      );
    });

  // Stop and discard the running VM. Cooperative shutdown revokes the VM's
  // in-memory key snapshot: after this, no further turns can send the old
  // key, so "Forget key"/key-replacement actually take effect.
  const stopSession = async (): Promise<void> => {
    if (booting) {
      const bootResult = await settleWithin(
        booting.then(() => undefined, () => undefined),
        STOP_TIMEOUT_MS,
      );
      if (!bootResult.completed) throw new Error("fen-web demo: boot did not settle while stopping");
    }
    const s = session;
    session = undefined;
    if (!s) return;

    // Restart/key replacement is a normal durability boundary: flush queued
    // writes before asking the VM to perform its cooperative shutdown. Both
    // operations are bounded so a hidden-tab rAF or stalled fetch cannot make
    // Restart permanently inert.
    const flushResult = await settleWithin(s.flush(), STOP_TIMEOUT_MS);
    if (flushResult.error !== undefined) {
      console.error("fen-web demo: session flush failed during stop", flushResult.error);
    } else if (!flushResult.completed) {
      console.error("fen-web demo: session flush timed out during stop");
    }

    const stopResult = await settleWithin(s.stop(), STOP_TIMEOUT_MS);
    if (!stopResult.completed || stopResult.error !== undefined) {
      console.error(
        !stopResult.completed
          ? "fen-web demo: cooperative stop timed out; hard-closing"
          : "fen-web demo: cooperative stop failed; hard-closing",
        stopResult.error,
      );
      // close() skips the cooperative quit hook and closes the poisoned VM
      // plus per-boot host resources directly. The flush attempt above is
      // deliberately before this fallback.
      const closeResult = await settleWithin(s.close(), STOP_TIMEOUT_MS);
      if (closeResult.error !== undefined) throw closeResult.error;
      if (!closeResult.completed) throw new Error("fen-web demo: hard close timed out");
      // A successful hard-close is sufficient for restart: the VM and its
      // per-boot resources are gone, so do not turn a hung cooperative stop
      // into a fatal panel.
      return;
    }
    if (flushResult.error !== undefined) throw flushResult.error;
  };

  async function restartSession(): Promise<void> {
    if (restarting) return;
    restarting = true;
    updateRestartButton();
    fatalVisible = false;
    try {
      // Always go through the ordinary browser boot assembly. In particular,
      // do not reuse the closed runtime: fs_kv and boot.fnl patch VM globals
      // without an uninstall path, so a restart must create a fresh VM.
      await stopSession();
      appMount.replaceChildren();
      if (!(await hasStartCredential(selectedProvider))) {
        // Match auto-start's credential gate: do not boot a VM that will only
        // fail while resolving os.getenv in the first turn.
        await renderSettings();
        return;
      }
      await startSession(selectedProvider);
    } catch (err) {
      await handleFatal(err);
    } finally {
      restarting = false;
      updateRestartButton();
    }
  }

  const renderSettings = async (): Promise<void> => {
    fatalVisible = false;
    noticeVisible = false;
    restartButton = undefined;
    settingsRoot.replaceChildren();
    const provider = providerById(selectedProvider);
    // Keyless providers (empty envVar, e.g. openai-codex) authenticate via
    // dev-server-bridged OAuth creds — no key row, save just (re)starts.
    const needsKey = provider.envVar !== "";
    const existing = needsKey ? ((await store.getApiKey(provider.envVar)) ?? "") : "";
    const running = session !== undefined || booting !== undefined;

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

    const input = el("input", {
      id: "api-key-input",
      type: "password",
      autocomplete: "off",
      placeholder: "sk-ant-…",
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
            await handleFatal(err);
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
          await handleFatal(err);
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
  try {
    const provider = providerById(selectedProvider);
    if (await hasStartCredential(provider.id)) await startSession(provider.id);
  } catch (err) {
    await handleFatal(err);
  }

  // Persist session write-backs on unload (best-effort durability).
  window.addEventListener("beforeunload", () => {
    void session?.flush().catch((err) => {
      console.error("fen-web demo: unload flush failed", err);
    });
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
