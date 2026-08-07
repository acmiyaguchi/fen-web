/**
 * Browser-side diagnostics state and markdown formatter.
 *
 * This module deliberately has no DOM/runtime imports: the VM cannot be
 * queried while a turn coroutine is running, so the browser records small
 * summaries as events pass the presenter seam and formats a snapshot later.
 */

export const DEFAULT_EVENT_LIMIT = 50;

declare const __FEN_VERSION: string | undefined;

/** Build-time fen version, with a runtime-safe fallback for node tests. */
export const FEN_VERSION =
  typeof __FEN_VERSION === "string" && __FEN_VERSION.trim().length > 0
    ? __FEN_VERSION.trim()
    : "unknown";

export interface DiagnosticError {
  message: string;
  stack?: string;
}

export interface DiagnosticEvent {
  timestamp: number;
  kind: string;
  summary: string;
}

export interface DiagnosticsContext {
  error?: DiagnosticError;
  provider?: string;
  model?: string;
  fenVersion?: string;
  fenWebVersion?: string;
  userAgent?: string;
  /** Stable storage facts kept outside the evictable event ring. */
  storagePersisted?: boolean;
  storageUsage?: number;
  storageQuota?: number;
  events?: readonly DiagnosticEvent[];
  /** Preview-console tail (#34); omitted when the preview host is absent. */
  previewConsoleTail?: readonly unknown[];
  /** Host console entries captured by the shell, when available. */
  hostConsole?: readonly unknown[];
}

const REDACTED = "[REDACTED]";
const UNREADABLE = "[unreadable]";
const CIRCULAR = "[Circular]";
const MAX_SUMMARY_LENGTH = 320;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
export const PREVIEW_DIAGNOSTICS_TAIL_LIMIT = 25;

/** String conversion must not be allowed to turn a hostile throwable into a
 * second exception while diagnostics are trying to describe it. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

function safeRead(value: object, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorStackOrMessage(value: unknown): string | undefined {
  if (!isError(value)) return undefined;
  const stack = safeRead(value, "stack");
  if (stack.ok && typeof stack.value === "string" && stack.value.length > 0) return stack.value;
  const message = safeRead(value, "message");
  if (message.ok && typeof message.value === "string") return message.value;
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  const errorText = errorStackOrMessage(value);
  if (errorText !== undefined) return errorText;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to a guarded String conversion for circular and hostile
    // objects. The structured path below handles circular objects directly.
  }
  return safeString(value);
}

/** Truncate by Unicode code point, never by UTF-16 code unit. */
function truncate(value: string, limit = MAX_SUMMARY_LENGTH): string {
  const characters = Array.from(value);
  return characters.length > limit
    ? `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`
    : value;
}

function entropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

/**
 * Remove credentials and token-shaped material from arbitrary error text.
 * Explicit secrets are checked first because a user's key can be short and
 * therefore cannot safely be identified by entropy alone.
 */
export function scrubSecrets(value: unknown, secrets: readonly string[] = []): string {
  let output = text(value);
  const explicit = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of explicit) output = output.split(secret).join(REDACTED);

  // Header values, including JSON-ish `x-api-key: ...` and Authorization:
  // Bearer ..., are scrubbed independently of the exact credential value.
  output = output.replace(
    /((?:authorization|x-api-key|api-key|apikey|access-token|auth-token)\s*["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi,
    `$1${REDACTED}`,
  );
  output = output.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`);

  // Common provider prefixes and JWTs. The lower bound avoids masking normal
  // prose while covering sk-ant, sk-, and OAuth-style token strings.
  output = output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  output = output.replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.?[^\s]*)\b/g, REDACTED);

  // Long, high-entropy bare tokens are usually opaque credentials. Restrict
  // the alphabet and require enough entropy to avoid swallowing URLs/words.
  output = output.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (candidate) =>
    entropy(candidate) >= 4.1 && /\d/.test(candidate) && /[A-Za-z]/.test(candidate)
      ? REDACTED
      : candidate,
  );
  return output;
}

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Match complete sensitive field names rather than arbitrary substrings.
 * This keeps useful fields such as `headerNames`, `tokenCount`, and `keymap`
 * visible. Suffixes used to label a value/map remain covered, but a numeric
 * or boolean value is never redacted below.
 */
function sensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return /^(?:key|token|secret|password|credential|authorization|auth_token|access_token|refresh_token|(?:[a-z0-9]+_)*api_key|x_api_key|(?:[a-z0-9]+_)*apikey|body|header|headers|cookie|cookies|set_cookie|session_token|session_key)(?:_value|_map|_data|_text)?$/.test(
    normalized,
  );
}

function scrubStructured(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > MAX_DEPTH) return "…";
  if (typeof value === "string") return truncate(scrubSecrets(value, secrets));
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return safeString(value);
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;

  if (typeof value === "object") {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    try {
      if (isError(value)) {
        const errorText = errorStackOrMessage(value);
        return errorText === undefined
          ? UNREADABLE
          : truncate(scrubSecrets(errorText, secrets));
      }

      let array = false;
      try {
        array = Array.isArray(value);
      } catch {
        return UNREADABLE;
      }
      if (array) {
        const lengthRead = safeRead(value, "length");
        if (!lengthRead.ok || typeof lengthRead.value !== "number") return UNREADABLE;
        const result: unknown[] = [];
        const length = Math.min(Math.max(0, Math.floor(lengthRead.value)), MAX_ITEMS);
        for (let i = 0; i < length; i += 1) {
          const item = safeRead(value, i);
          result.push(
            item.ok ? scrubStructured(item.value, secrets, depth + 1, seen) : UNREADABLE,
          );
        }
        return result;
      }

      let keys: string[];
      try {
        keys = Object.keys(value);
      } catch {
        return UNREADABLE;
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys.slice(0, MAX_ITEMS)) {
        const item = safeRead(value, key);
        if (!item.ok) {
          result[key] = UNREADABLE;
          continue;
        }
        // Header names are intentionally retained; only a headers map is a
        // sensitive value. For all other sensitive names, retain safe scalar
        // numbers/booleans while hiding strings and nested material.
        if (sensitiveKey(key)) {
          result[key] =
            item.value !== null &&
            (typeof item.value === "string" || typeof item.value === "object")
              ? REDACTED
              : item.value;
        } else {
          result[key] = scrubStructured(item.value, secrets, depth + 1, seen);
        }
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return safeString(value);
}

/** Make a bounded, scrubbed one-line representation suitable for the ring. */
export function summarizePayload(value: unknown, secrets: readonly string[] = []): string {
  let structured: unknown;
  try {
    structured = scrubStructured(value, secrets);
  } catch {
    // This is deliberately defensive even though scrubStructured guards each
    // operation: a Proxy can throw from traps that are added by a future JS
    // builtin or host object implementation.
    structured = UNREADABLE;
  }
  let result = typeof structured === "string" ? structured : text(structured);
  result = scrubSecrets(result, secrets).replace(/[\r\n]+/g, " ").trim();
  return truncate(result);
}

function normalizeError(error: unknown, secrets: readonly string[]): DiagnosticError {
  if (isError(error)) {
    const message = safeRead(error, "message");
    const stack = safeRead(error, "stack");
    return {
      message: scrubSecrets(message.ok ? message.value : text(error), secrets),
      ...(stack.ok && typeof stack.value === "string"
        ? { stack: scrubSecrets(stack.value, secrets) }
        : {}),
    };
  }
  if (typeof error === "string") return { message: scrubSecrets(error, secrets) };
  if (error && typeof error === "object") {
    const candidate = error as object;
    const message = safeRead(candidate, "message");
    const stack = safeRead(candidate, "stack");
    return {
      message: scrubSecrets(
        message.ok && message.value !== undefined ? message.value : text(error),
        secrets,
      ),
      ...(stack.ok && typeof stack.value === "string"
        ? { stack: scrubSecrets(stack.value, secrets) }
        : {}),
    };
  }
  return { message: scrubSecrets(error, secrets) };
}

function sectionLines(title: string, entries: readonly unknown[], secrets: readonly string[]): string[] {
  return [
    `## ${title}`,
    "",
    "```text",
    ...entries.map((entry) => scrubSecrets(summarizePayload(entry, secrets), secrets)),
    "```",
    "",
  ];
}

/** Format a cleanly pasteable Markdown/plain-text diagnostics report. */
export function formatDiagnostics(context: DiagnosticsContext, secrets: readonly string[] = []): string {
  const lines: string[] = [
    "# fen-web diagnostics",
    "",
    "> Credentials are scrubbed, but recent turn events may include excerpts",
    "> of your prompts, responses, and tool output — review before sharing.",
    "",
    "## Environment",
    "",
  ];
  const fields: Array<[string, unknown]> = [
    ["Provider", context.provider ?? "unknown"],
    ["Model", context.model ?? "unknown"],
    ["fen version", context.fenVersion ?? FEN_VERSION],
    ["fen-web version", context.fenWebVersion ?? "unknown"],
    ["Browser UA", context.userAgent ?? "unknown"],
    ["Storage persisted", context.storagePersisted ?? "unknown"],
    ["Storage usage", context.storageUsage ?? "unknown"],
    ["Storage quota", context.storageQuota ?? "unknown"],
  ];
  for (const [label, value] of fields) {
    lines.push(`- ${label}: ${scrubSecrets(text(value), secrets)}`);
  }
  lines.push("");

  if (context.error) {
    const error = normalizeError(context.error, secrets);
    lines.push("## Error", "", `Message: ${error.message}`, "");
    if (error.stack) lines.push("Stack:", "```text", error.stack, "```", "");
  }

  const events = context.events ?? [];
  lines.push("## Recent turn events", "", "```text");
  if (events.length === 0) lines.push("(none)");
  for (const event of events) {
    const stamp = new Date(event.timestamp).toISOString();
    lines.push(`${stamp} ${scrubSecrets(event.kind, secrets)} — ${scrubSecrets(event.summary, secrets)}`);
  }
  lines.push("```", "");

  const previewTail = context.previewConsoleTail?.slice(-PREVIEW_DIAGNOSTICS_TAIL_LIMIT);
  if (previewTail && previewTail.length > 0) {
    lines.push(...sectionLines("Preview console (tail)", previewTail, secrets));
  }
  if (context.hostConsole && context.hostConsole.length > 0) {
    lines.push(...sectionLines("Host console (recent)", context.hostConsole, secrets));
  }
  return `${scrubSecrets(lines.join("\n"), secrets).trim()}\n`;
}

export interface DiagnosticsOptions {
  limit?: number;
  secrets?: readonly string[];
}

export interface DiagnosticsStorageApi {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export type PreviewConsoleTailProvider = () => readonly unknown[];

/** Bounded state holder used by the browser shell and by boot.ts. */
export class DiagnosticsBuffer {
  private readonly limit: number;
  private readonly events: DiagnosticEvent[] = [];
  private readonly secrets = new Set<string>();
  private readonly hostConsole: unknown[] = [];
  private readonly collapsed = new Map<
    string,
    { summary: string; event: DiagnosticEvent; count: number }
  >();
  private storageApi: DiagnosticsStorageApi | undefined;
  private previewConsoleTailProvider?: PreviewConsoleTailProvider;
  private context: Omit<DiagnosticsContext, "events" | "hostConsole"> = {};

  constructor(options: DiagnosticsOptions = {}) {
    this.limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_EVENT_LIMIT));
    for (const secret of options.secrets ?? []) this.addSecret(secret);
  }

  addSecret(secret: unknown): void {
    if (typeof secret === "string" && secret.length > 0) this.secrets.add(secret);
  }

  setContext(context: Omit<DiagnosticsContext, "events" | "hostConsole">): void {
    this.context = { ...this.context, ...context };
  }

  /** Attach the host-side preview ring without draining it for a report. */
  setPreviewConsoleTailProvider(provider: PreviewConsoleTailProvider | undefined): void {
    this.previewConsoleTailProvider = provider;
  }

  record(kind: unknown, payload?: unknown, timestamp = Date.now()): void {
    const secrets = [...this.secrets];
    const event: DiagnosticEvent = {
      timestamp,
      kind: scrubSecrets(safeString(kind), secrets),
      summary: summarizePayload(payload ?? "", secrets),
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  /** Record a recurring diagnostic without consuming one ring slot per
   * occurrence. The first occurrence is retained; repeats update a compact
   * counter every ten observations, and a changed summary starts a new event. */
  recordCollapsed(kind: unknown, payload?: unknown, timestamp = Date.now()): void {
    const secrets = [...this.secrets];
    const normalizedKind = scrubSecrets(safeString(kind), secrets);
    const summary = summarizePayload(payload ?? "", secrets);
    const previous = this.collapsed.get(normalizedKind);
    if (previous && previous.summary === summary && this.events.includes(previous.event)) {
      previous.count += 1;
      if (previous.count % 10 === 0) {
        previous.event.timestamp = timestamp;
        previous.event.summary = `${summary} (repeated ${previous.count} times)`;
      }
      return;
    }
    this.record(normalizedKind, summary, timestamp);
    const event = this.events[this.events.length - 1];
    if (event) this.collapsed.set(normalizedKind, { summary, event, count: 1 });
  }

  setStorageEstimateSource(storage: DiagnosticsStorageApi | undefined): void {
    this.storageApi = storage;
  }

  /** Refresh the cached estimate without making diagnostics/boot depend on
   * StorageManager availability. Callers can await this before formatting a
   * report; the stable context then survives event-ring eviction. */
  async refreshStorageEstimate(storage = this.storageApi): Promise<void> {
    if (typeof storage?.estimate !== "function") return;
    try {
      const estimate = await storage.estimate();
      this.setContext({
        ...(typeof estimate.usage === "number" ? { storageUsage: estimate.usage } : {}),
        ...(typeof estimate.quota === "number" ? { storageQuota: estimate.quota } : {}),
      });
    } catch {
      // A failed opportunistic estimate leaves the last known boot value.
    }
  }

  /** Record the event shape emitted by the Fennel presenter bus listener. */
  recordBusEvent(event: unknown): void {
    if (event && typeof event === "object") {
      const value = event as object;
      const infoRead = safeRead(value, "info");
      const info =
        infoRead.ok && infoRead.value && typeof infoRead.value === "object"
          ? (infoRead.value as object)
          : value;
      const providerRead = safeRead(info, "provider");
      const modelRead = safeRead(info, "model");
      const provider = providerRead.ok && typeof providerRead.value === "string" ? providerRead.value : undefined;
      const model = modelRead.ok && typeof modelRead.value === "string" ? modelRead.value : undefined;
      if (provider || model) {
        this.setContext({ ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
      }
      const typeRead = safeRead(value, "type");
      this.record(typeRead.ok ? typeRead.value ?? "bus" : "bus", value);
    } else {
      this.record("bus", event);
    }
  }

  recordError(error: unknown): void {
    const normalized = normalizeError(error, [...this.secrets]);
    const summary = summarizePayload(normalized, [...this.secrets]);
    const previous = this.events[this.events.length - 1];
    // Boot.ts records a fatal before invoking the shell's onFatal callback.
    // Make the shell-side record idempotent for that same most-recent error.
    if (previous?.kind === "error" && previous.summary === summary) return;
    this.record("error", normalized);
  }

  recordHostConsole(level: string, args: readonly unknown[]): void {
    this.hostConsole.push({ level, message: summarizePayload(args, [...this.secrets]) });
    if (this.hostConsole.length > this.limit) this.hostConsole.shift();
  }

  snapshot(error?: unknown): string {
    return formatDiagnostics(
      {
        ...this.context,
        ...(error === undefined ? {} : { error: normalizeError(error, [...this.secrets]) }),
        events: this.events,
        previewConsoleTail: this.previewConsoleTailProvider?.(),
        hostConsole: this.hostConsole,
      },
      [...this.secrets],
    );
  }

  get recentEvents(): readonly DiagnosticEvent[] {
    return this.events.slice();
  }
}
