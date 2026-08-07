import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export default defineConfig({
  testDir: path.resolve(here, "tests"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["dot"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173/",
    browserName: "chromium",
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build and preview the production bundle rather than exercising Vite's
    // dev-only module graph. FEN_WEB_BASE keeps the static preview rooted at
    // the Playwright baseURL instead of the GitHub Pages /fen-web/ prefix.
    command:
      "FEN_WEB_BASE=/ npm run build && FEN_WEB_BASE=/ npm run preview -w @fen-web/web -- --host 127.0.0.1",
    cwd: repoRoot,
    url: "http://127.0.0.1:4173/",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
