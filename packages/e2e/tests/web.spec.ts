import { expect, test } from "@playwright/test";
import { ScriptedAnthropicRouter } from "./anthropicRouter.js";
import {
  FAKE_KEY,
  expectTranscript,
  openSettings,
  readIndexedDbValue,
  startWithFakeKey,
  submitPrompt,
  triggerFatalSchedulerError,
} from "./helpers.js";

test.describe("browser happy path", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("boots through the key gate and renders a scripted assistant turn on mobile", async ({ page }) => {
    const router = new ScriptedAnthropicRouter(page, "happy.json");
    await router.install();
    await startWithFakeKey(page);

    await submitPrompt(page, "Say hello from the scripted provider.");
    await expectTranscript(page, "> Say hello from the scripted provider.");
    await expectTranscript(page, "Hello from the scripted provider.");
    await expect(page.locator("#fen-input")).toBeVisible();

    await router.assertComplete();
  });

  test("stops a delayed provider turn and accepts a follow-up turn", async ({ page }) => {
    const router = new ScriptedAnthropicRouter(page, "cancel.json");
    await router.install();
    await startWithFakeKey(page);

    await submitPrompt(page, "Stop the runaway turn.");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Stop", exact: true }).click();

    await expectTranscript(page, "cancelled");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();

    await submitPrompt(page, "Work after cancellation.");
    await expectTranscript(page, "The follow-up turn worked.");
    await router.assertComplete();
  });
});

test("sends a non-ASCII user prompt as valid JSON to the scripted provider", async ({ page }) => {
  const prompt = "Say hello with café, an em dash — and emoji 💥.";
  const router = new ScriptedAnthropicRouter(page, "non-ascii.json");
  await router.install();
  await startWithFakeKey(page);

  await submitPrompt(page, prompt);
  await expectTranscript(page, "> " + prompt);
  await expectTranscript(page, "café — 💥");

  await router.assertComplete();
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("submits a multiline prompt as one message", async ({ page }) => {
    const router = new ScriptedAnthropicRouter(page, "multiline.json");
    await router.install();
    await startWithFakeKey(page);
    await expect(page.locator("#fen-status")).toBeVisible();
    await expect(page.locator("#fen-inputbar")).toBeVisible();

    const input = page.locator("#fen-input");
    await input.fill("one\ntwo\nthree\nfour\nfive");
    await expect
      .poll(() => input.evaluate((element) => getComputedStyle(element).overflowY))
      .toBe("auto");
    await input.fill("First line");
    await input.press("Shift+Enter");
    await input.type("Second line");
    await expect(input).toHaveValue("First line\nSecond line");
    await input.press("Enter");

    await expectTranscript(page, "> First line\nSecond line");
    await expectTranscript(page, "Hello from the scripted provider.");
    await router.assertComplete();
  });

  test("collapses and expands the sandbox preview", async ({ page }) => {
    const router = new ScriptedAnthropicRouter(page, "tool-preview.json");
    await router.install();
    await startWithFakeKey(page);

    await submitPrompt(page, "Write the e2e preview file and refresh the preview.");
    await expectTranscript(page, "The preview was refreshed.");

    const frame = page.locator("#fen-preview-frame");
    const toggle = page.locator(".fen-preview-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Hide preview");
    await expect(frame).toBeVisible();
    await toggle.click();
    await expect(frame).toBeHidden();
    await expect(toggle).toHaveText("Show preview");
    await toggle.click();
    await expect(frame).toBeVisible();

    await router.assertComplete();
  });
});

test("executes ordered Anthropic tool_use turns, persists the file, and refreshes the sandbox preview", async ({
  page,
}) => {
  const router = new ScriptedAnthropicRouter(page, "tool-preview.json");
  await router.install();
  await startWithFakeKey(page);

  await submitPrompt(page, "Write the e2e preview file and refresh the preview.");
  await expectTranscript(page, "The preview was refreshed.");

  await expect
    .poll(() => readIndexedDbValue(page, "fs:/e2e-preview.html"), {
      timeout: 10_000,
      message: "write tool output should be durable in IndexedDB",
    })
    .toContain("E2E preview content");

  const frame = page.locator("#fen-preview-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
  await expect(page.frameLocator("#fen-preview-frame").locator("#e2e-preview")).toHaveText(
    "E2E preview content",
  );

  await router.assertComplete();
});

test("drives the seeded starter todo through preview_interact and preview_dom", async ({ page }) => {
  // The browser boot seeds apps/web/starter into IndexedDB before the VM
  // starts. The scripted turn uses the always-visible preview tools to render,
  // type, submit, and inspect the real sandboxed document.
  const router = new ScriptedAnthropicRouter(page, "preview-starter.json");
  await router.install();
  await startWithFakeKey(page);

  await submitPrompt(page, "Drive the seeded starter todo app in the live preview.");
  await expectTranscript(page, "The seeded starter preview is ready for live iframe interaction.");

  const frame = page.frameLocator("#fen-preview-frame");
  await expect(page.locator("#fen-preview-frame")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame.locator("#new-todo")).toBeVisible();
  await expect(frame.locator("#todo-list li")).toHaveCount(1);
  await expect(frame.locator("#todo-list li .todo-text")).toHaveText("Ship the iframe todo");
  await expect(frame.locator("#remaining-count")).toHaveText("1");

  await router.assertComplete();
});

test("shows fatal panel, restarts a fresh session, and preserves pre-crash workspace data", async ({
  page,
}) => {
  const router = new ScriptedAnthropicRouter(page, "restart.json");
  await router.install();
  await startWithFakeKey(page);

  await submitPrompt(page, "Persist a file before the crash.");
  await expectTranscript(page, "Saved before the crash.");
  await expect
    .poll(() => readIndexedDbValue(page, "fs:/survives-restart.txt"), {
      timeout: 10_000,
      message: "pre-crash workspace file should be durable before restart",
    })
    .toBe("workspace survives restart");

  await triggerFatalSchedulerError(page);
  await page.evaluate(() => {
    const original = (window as Window & { __e2eOriginalRaf?: typeof requestAnimationFrame })
      .__e2eOriginalRaf;
    if (original) window.requestAnimationFrame = original;
  });
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.locator(".fatal-panel")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#fen-input")).toBeVisible({ timeout: 20_000 });

  // Document-wide census: the #38 skeleton ids live under #fen-app, but the
  // preview iframe (#fen-preview-frame) is a sibling — a duplicated iframe
  // after restart must be caught too.
  const ids = await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size, "fresh presenter must not leave duplicate id nodes").toBe(ids.length);
  await expect
    .poll(() => readIndexedDbValue(page, "fs:/survives-restart.txt"), {
      timeout: 10_000,
      message: "restart must not wipe the persisted workspace row (raw IndexedDB check)",
    })
    .toBe("workspace survives restart");

  // The restarted session must WORK, not merely render an input: send a turn
  // whose fixture makes the fresh VM read the pre-crash file back through the
  // real read tool — the router asserts the tool_result carries the content.
  await submitPrompt(page, "After the restart, read back the survival file.");
  await expectTranscript(page, "Post-restart read succeeded.");

  await router.assertComplete();
});

test("copies diagnostics with the API key scrubbed and the credential warning present", async ({
  page,
}) => {
  const router = new ScriptedAnthropicRouter(page, "happy.json");
  await router.install();
  await startWithFakeKey(page, FAKE_KEY);
  await submitPrompt(page, "Say hello from the scripted provider.");
  await expectTranscript(page, "Hello from the scripted provider.");

  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("diagnostics e2e error"),
        message: "diagnostics e2e error",
      }),
    );
  });
  await expect(page.locator(".fatal-panel")).toContainText("fen-web noticed a page error");
  const copy = page.getByRole("button", { name: "Copy diagnostics", exact: true });
  await copy.click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
      timeout: 5_000,
      message: "diagnostics copy button should write to the browser clipboard",
    })
    .toContain("# fen-web diagnostics");
  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain("> Credentials are scrubbed, but recent turn events may include excerpts");
  expect(report).toContain("diagnostics e2e error");
  expect(report).not.toContain(FAKE_KEY);

  await router.assertComplete();
});

test.describe("provider error fixtures", () => {
  test("renders a 429 response as a visible transcript error", async ({ page }) => {
    // rate-limit.json repeats the response four times to match retry.fnl's
    // DEFAULT-MAX-ATTEMPTS; AGENT_FENNEL_RETRY=0 would collapse attempts to one.
    const router = new ScriptedAnthropicRouter(page, "rate-limit.json");
    await router.install();
    await startWithFakeKey(page);

    await submitPrompt(page, "Trigger a rate limit.");
    await expect(page.locator("#fen-transcript .style-error")).toContainText(
      /HTTP 429[\s\S]*e2e rate limit/,
      { timeout: 20_000 },
    );
    await router.assertComplete();
  });

  test("renders a truncated stream as a visible incomplete-stream error", async ({ page }) => {
    // truncated.json repeats the response four times to match retry.fnl's
    // DEFAULT-MAX-ATTEMPTS; AGENT_FENNEL_RETRY=0 would collapse attempts to one.
    const router = new ScriptedAnthropicRouter(page, "truncated.json");
    await router.install();
    await startWithFakeKey(page);

    await submitPrompt(page, "Trigger a truncated stream.");
    await expect(page.locator("#fen-transcript .style-error")).toContainText(
      "stream ended without a completion event",
      { timeout: 20_000 },
    );
    await router.assertComplete();
  });
});

// Keep this assertion close to the tests that rely on the fake credential: it
// documents that the browser route sees the key only as the provider header,
// while diagnostics never copy it into the report.
test("uses the planted key only on the intercepted Anthropic wire request", async ({ page }) => {
  const router = new ScriptedAnthropicRouter(page, "happy.json", FAKE_KEY);
  await router.install();
  await openSettings(page);
  await page.locator("#api-key-input").fill(FAKE_KEY);
  await page.getByRole("button", { name: "Save & start", exact: true }).click();
  await expect(page.locator("#fen-input")).toBeVisible({ timeout: 20_000 });
  await submitPrompt(page, "Say hello from the scripted provider.");
  await expectTranscript(page, "Hello from the scripted provider.");
  await router.assertComplete();
});
