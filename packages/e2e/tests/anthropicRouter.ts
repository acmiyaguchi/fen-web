import { expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "..", "fixtures");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface TurnExpectation {
  userText?: string;
  toolResultId?: string;
  /** Substring that must appear in some tool_result content of the request —
   * proves the VM actually produced that result (e.g. read a file back). */
  toolResultText?: string;
}

interface ScriptResponse {
  fixture: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  /** Delay fulfillment so Stop/Esc can abort an in-flight request. */
  delayMs?: number;
  /** An aborted delayed route is an expected consumed fixture turn. */
  allowAbort?: boolean;
}

interface ScriptTurn {
  request?: TurnExpectation;
  response: ScriptResponse;
}

interface ScriptFile {
  name: string;
  turns: ScriptTurn[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadScript(name: string): ScriptFile {
  const file = path.resolve(fixturesDir, name);
  if (!file.startsWith(`${fixturesDir}${path.sep}`)) {
    throw new Error(`fixture path escapes e2e/fixtures: ${name}`);
  }
  const script = JSON.parse(readFileSync(file, "utf8")) as ScriptFile;
  if (!script.name || !Array.isArray(script.turns) || script.turns.length === 0) {
    throw new Error(`invalid ordered Anthropic fixture script: ${name}`);
  }
  return script;
}

function textValues(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    return typeof value.text === "string" ? [value.text] : [];
  });
}

function lastUserText(body: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const value = message as Record<string, unknown>;
    if (value.role !== "user") continue;
    return textValues(value.content).join("");
  }
  return undefined;
}

function toolResultTexts(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      if (value.type !== "tool_result") return [];
      const inner = value.content;
      if (typeof inner === "string") return [inner];
      return textValues(inner);
    });
  });
}

function toolResultIds(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      return value.type === "tool_result" && typeof value.tool_use_id === "string"
        ? [value.tool_use_id]
        : [];
    });
  });
}

/**
 * Strict wire-level Anthropic mock. Every request consumes exactly one turn
 * from the fixture script. A request with the wrong body or one beyond the
 * script is aborted and retained as a test failure instead of becoming an
 * accidental real-provider call or a silent app error.
 */
export class ScriptedAnthropicRouter {
  private readonly script: ScriptFile;
  private nextTurn = 0;
  private requestCount = 0;
  private failure: Error | undefined;

  constructor(
    private readonly page: Page,
    scriptName: string,
    private readonly expectedApiKey?: string,
  ) {
    this.script = loadScript(scriptName);
  }

  async install(): Promise<void> {
    // Catch-all guard first (Playwright matches most-recently-registered
    // routes first, so the exact-URL mock below shadows this for the real
    // endpoint): any OTHER Anthropic-origin request — a query param added,
    // a path drift — is a scripting bug and must fail the test, not escape
    // to the live network.
    await this.page.route("https://api.anthropic.com/**", async (route) => {
      this.failure ??= new Error(
        `Anthropic mock: unrouted provider request escaped the script: ${route.request().url()}`,
      );
      await route.abort("failed").catch(() => undefined);
    });
    await this.page.route(ANTHROPIC_URL, (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    this.requestCount += 1;
    try {
      const request = route.request();
      if (request.method() !== "POST") {
        throw new Error(`Anthropic mock expected POST, got ${request.method()}`);
      }
      if (this.expectedApiKey !== undefined && request.headers()["x-api-key"] !== this.expectedApiKey) {
        throw new Error("Anthropic mock did not receive the planted API key in x-api-key");
      }
      const turn = this.script.turns[this.nextTurn];
      if (!turn) {
        throw new Error(
          `Anthropic mock received unexpected request #${this.requestCount}; ` +
            `script '${this.script.name}' has only ${this.script.turns.length} turn(s)`,
        );
      }
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new Error("Anthropic mock received invalid JSON body");
      const expected = turn.request;
      if (expected?.userText !== undefined && lastUserText(body) !== expected.userText) {
        throw new Error(
          `Anthropic mock request #${this.requestCount} is out of order: ` +
            `expected last user text ${JSON.stringify(expected.userText)}, got ${JSON.stringify(lastUserText(body))}`,
        );
      }
      if (expected?.toolResultId !== undefined && !toolResultIds(body).includes(expected.toolResultId)) {
        throw new Error(
          `Anthropic mock request #${this.requestCount} is out of order: ` +
            `expected tool result ${expected.toolResultId}, got ${JSON.stringify(toolResultIds(body))}`,
        );
      }
      if (
        expected?.toolResultText !== undefined &&
        !toolResultTexts(body).some((text) => text.includes(expected.toolResultText as string))
      ) {
        throw new Error(
          `Anthropic mock request #${this.requestCount}: no tool_result content contains ` +
            `${JSON.stringify(expected.toolResultText)} (got ${JSON.stringify(toolResultTexts(body))})`,
        );
      }

      const response = turn.response;
      const fixturePath = path.resolve(fixturesDir, response.fixture);
      if (!fixturePath.startsWith(`${fixturesDir}${path.sep}`)) {
        throw new Error(`Anthropic mock response fixture escapes e2e/fixtures: ${response.fixture}`);
      }
      const bodyText = readFileSync(fixturePath, "utf8");
      this.nextTurn += 1;
      if (response.delayMs && response.delayMs > 0) await sleep(response.delayMs);
      try {
        await route.fulfill({
          status: response.status ?? 200,
          contentType: response.contentType ?? "text/event-stream",
          headers: { ...response.headers, "Access-Control-Expose-Headers": "retry-after-ms" },
          body: bodyText,
        });
      } catch (error) {
        // A browser Stop aborts the request while this delayed fixture is
        // pending. The route is already consumed and this failure is the
        // expected transport observation, not a router-script failure.
        if (!response.allowAbort) throw error;
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await route.abort("failed").catch(() => undefined);
    }
  }

  async assertComplete(): Promise<void> {
    if (this.failure) throw this.failure;
    expect(this.requestCount, `${this.script.name}: unexpected request sequence`).toBe(
      this.script.turns.length,
    );
    expect(this.nextTurn, `${this.script.name}: not all fixture turns were consumed`).toBe(
      this.script.turns.length,
    );
  }
}
