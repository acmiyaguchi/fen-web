import { expect, type Page } from "@playwright/test";

export const FAKE_KEY = "sk-ant-api03-e2e-planted-secret-123456";

/** Each Playwright test gets a brand-new browser context, which gives it a
 * fresh origin storage area (including IndexedDB) without sharing state with
 * another scenario. */
export async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#settings-form")).toBeVisible();
  await expect(page.locator("#api-key-input")).toBeVisible();
}

export async function startWithFakeKey(page: Page, key = FAKE_KEY): Promise<void> {
  await openSettings(page);
  await page.locator("#api-key-input").fill(key);
  await page.getByRole("button", { name: "Save & start", exact: true }).click();
  await expect(page.locator("#fen-input")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#fen-inputbar")).toBeVisible();
}

export async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.locator("#fen-input");
  await input.fill(prompt);
  await input.press("Enter");
}

export async function expectTranscript(page: Page, text: string): Promise<void> {
  await expect(page.locator("#fen-transcript")).toContainText(text, { timeout: 20_000 });
}

export async function readIndexedDbValue(page: Page, key: string): Promise<string | undefined> {
  return page.evaluate(
    async (lookupKey) =>
      new Promise<string | undefined>((resolve, reject) => {
        const open = indexedDB.open("fen-web-demo");
        open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("kv", "readonly");
          const request = tx.objectStore("kv").get(lookupKey);
          request.onerror = () => {
            db.close();
            reject(request.error ?? new Error("IndexedDB read failed"));
          };
          request.onsuccess = () => {
            const value = request.result;
            db.close();
            resolve(typeof value === "string" ? value : undefined);
          };
        };
      }),
    key,
  );
}

export async function triggerFatalSchedulerError(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & {
      __e2eOriginalRaf?: typeof requestAnimationFrame;
    };
    win.__e2eOriginalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => {
      throw new Error("e2e injected run-loop crash");
    };
  });
  await expect(page.locator(".fatal-panel")).toContainText("fen-web stopped", {
    timeout: 20_000,
  });
  await expect(page.locator(".fatal-message")).toContainText("e2e injected run-loop crash");
}
