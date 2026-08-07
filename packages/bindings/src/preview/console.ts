import type { PreviewConsoleEntry, PreviewConsoleLevel } from "./types.js";

/** Boundaries shared by the iframe harness and the host-side defensive copy. */
export const PREVIEW_CONSOLE_MAX_ENTRIES = 200;
export const PREVIEW_CONSOLE_MAX_ARGS = 20;
export const PREVIEW_CONSOLE_MAX_TEXT = 800;
/** Maximum serialized text returned by the synchronous Lua-facing drain. */
export const PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT = 64 * 1024;

const LEVELS: readonly PreviewConsoleLevel[] = ["log", "warn", "error", "info", "debug"];

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

function truncate(value: string, limit = PREVIEW_CONSOLE_MAX_TEXT): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

function level(value: unknown): PreviewConsoleLevel {
  return typeof value === "string" && LEVELS.includes(value as PreviewConsoleLevel)
    ? (value as PreviewConsoleLevel)
    : "log";
}

/**
 * Normalize a message crossing the postMessage boundary. The iframe harness
 * already stringifies arguments, but this second cap keeps a hostile app from
 * filling the parent ring with an unexpectedly large synthetic message (and
 * makes FakePreview accept the same shape as WebHostPreview).
 */
export function normalizePreviewConsoleEntry(value: unknown): PreviewConsoleEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const argsValue = record.args;
  const args = Array.isArray(argsValue)
    ? argsValue
        .slice(0, PREVIEW_CONSOLE_MAX_ARGS)
        .map((arg) => truncate(typeof arg === "string" ? arg : safeString(arg)))
    : argsValue === undefined
      ? []
      : [truncate(typeof argsValue === "string" ? argsValue : safeString(argsValue))];
  const stack =
    typeof record.stack === "string" && record.stack.length > 0
      ? truncate(record.stack, PREVIEW_CONSOLE_MAX_TEXT * 4)
      : undefined;
  return {
    level: level(record.level),
    args,
    ...(stack === undefined ? {} : { stack }),
    ...(record.uncaught === true ? { uncaught: true } : {}),
  };
}

export function copyPreviewConsoleEntries(entries: readonly PreviewConsoleEntry[]): PreviewConsoleEntry[] {
  return entries.map((entry) => ({
    level: entry.level,
    args: entry.args.slice(),
    ...(entry.stack === undefined ? {} : { stack: entry.stack }),
    ...(entry.uncaught ? { uncaught: true } : {}),
  }));
}

function omittedEntry(count: number): PreviewConsoleEntry {
  return {
    level: "warn",
    args: [
      `[preview_console: ${count} older entr${count === 1 ? "y" : "ies"} omitted; ` +
        `aggregate capped at ${PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT} characters]`,
    ],
  };
}

/**
 * Serialize a drain without allowing the aggregate to cross the Lua boundary
 * unbounded. The newest entries win; when older entries do not fit, a final
 * synthetic warning says exactly how many were omitted.
 */
export function serializePreviewConsoleEntries(entries: readonly unknown[]): string {
  const normalized = entries
    .map((entry) => normalizePreviewConsoleEntry(entry))
    .filter((entry): entry is PreviewConsoleEntry => entry !== undefined);
  if (normalized.length === 0) return "[]";

  // Widest fitting window wins: try keeping everything first, then shed the
  // OLDEST entries one at a time until the serialized aggregate fits. (An
  // earlier version iterated from the newest-only candidate and returned the
  // first fit — which trivially always fit, discarding all but one entry.)
  for (let first = 0; first < normalized.length; first += 1) {
    const kept = normalized.slice(first);
    const omitted = first;
    const payload = omitted > 0 ? [...kept, omittedEntry(omitted)] : kept;
    const text = JSON.stringify(payload);
    if (text.length <= PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT) return text;
  }

  // normalizePreviewConsoleEntry bounds every individual entry well below the
  // aggregate cap. Keep this fallback defensive if those constants change.
  const text = JSON.stringify([omittedEntry(normalized.length)]);
  return text.length <= PREVIEW_CONSOLE_MAX_AGGREGATE_TEXT ? text : "[]";
}
