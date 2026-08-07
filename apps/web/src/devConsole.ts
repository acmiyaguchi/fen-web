import type { IncomingMessage, ServerResponse } from "node:http";

export const FEN_CONSOLE_ENDPOINT = "/__fen/console";
export const MAX_CONSOLE_BODY_BYTES = 64 * 1024;

type ConsoleLevel = "debug" | "info" | "log" | "trace" | "warn" | "error";

export interface ConsoleEntry {
  level: ConsoleLevel;
  args: unknown[];
  stack?: string;
  ts?: number;
}

export interface ConsoleMiddlewareOptions {
  maxBodyBytes?: number;
  sink?: (line: string) => void;
  color?: boolean;
}

const LEVELS = new Set<ConsoleLevel>(["debug", "info", "log", "trace", "warn", "error"]);
const COLORS: Record<ConsoleLevel, string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  log: "",
  trace: "\u001b[35m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const RESET = "\u001b[0m";
const MAX_LINE_LENGTH = 8 * 1024;
const MAX_STACK_LENGTH = 4 * 1024;

/** Loopback, or a Tailscale peer, matching the dev auth bridge's trust gate. */
export function trustedClient(req: Pick<IncomingMessage, "socket">): boolean {
  let addr = req.socket.remoteAddress ?? "";
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  if (addr === "127.0.0.1" || addr === "::1") return true;
  const octets = addr.split(".").map(Number);
  if (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
    return true;
  }
  return addr.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // An explicit opaque origin is never same-origin, regardless of the
  // browser's fetch-metadata ordering or whether Sec-Fetch-Site is absent.
  if (origin === "null") return false;

  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;

  // Sec-Fetch-Site is absent in curl and older browsers. When an Origin is
  // supplied, compare it with the request host as an additional same-origin
  // check without requiring a particular localhost spelling or port.
  if (typeof origin !== "string") return true;
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) return false;
  try {
    const parsed = new URL(origin);
    const protocol = (req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted
      ? "https:"
      : "http:";
    return parsed.protocol === protocol && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function respond(res: ServerResponse, statusCode: number, body?: string): void {
  res.statusCode = statusCode;
  if (body !== undefined) res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

class BodyTooLargeError extends Error {
  constructor() {
    super("console payload too large");
  }
}

function destroyRequest(req: IncomingMessage): void {
  try {
    req.destroy();
  } catch {
    try {
      req.socket.destroy();
    } catch {
      // The request may already be closed; there is nothing else to drain.
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk: unknown) => {
      if (settled) return;
      try {
        const part = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        total += part.byteLength;
        if (total > maxBytes) {
          fail(new BodyTooLargeError());
          destroyRequest(req);
          return;
        }
        chunks.push(part);
      } catch (error) {
        fail(error);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

function compact(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  } catch {
    return "[unserializable]";
  }
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function normalizeLevel(value: unknown): ConsoleLevel {
  return typeof value === "string" && LEVELS.has(value as ConsoleLevel)
    ? (value as ConsoleLevel)
    : "log";
}

function parseBatch(body: string): ConsoleEntry[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((candidate): ConsoleEntry[] => {
    if (candidate === null || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const args = Array.isArray(record.args)
      ? record.args
      : record.args === undefined
        ? []
        : [record.args];
    const stack = typeof record.stack === "string" ? clip(record.stack, MAX_STACK_LENGTH) : undefined;
    const ts = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : undefined;
    return [{ level: normalizeLevel(record.level), args, ...(stack === undefined ? {} : { stack }), ...(ts === undefined ? {} : { ts }) }];
  });
}

/** Remove terminal controls while keeping stack readability without allowing
 * attacker-controlled text to start a fresh terminal log line. */
function sanitizeTerminalText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0a) {
      result += "\n    ";
    } else if (code > 0x1f && code !== 0x7f) {
      result += value[index];
    }
  }
  return result;
}

function formatEntry(entry: ConsoleEntry, color: boolean): string {
  const prefix = `[web:${sanitizeTerminalText(entry.level)}]`;
  const args = entry.args.map(compact).join(" ");
  const stack = entry.stack === undefined
    ? ""
    : `\n${clip(sanitizeTerminalText(entry.stack), MAX_STACK_LENGTH)}`;
  const line = clip(`${prefix} ${args}${stack}`.trimEnd(), MAX_LINE_LENGTH);
  return color ? `${COLORS[entry.level]}${line}${RESET}` : line;
}

/**
 * Connect middleware for the dev-only host console bridge. Keeping this
 * separate from the Vite plugin makes the request/body safety rules directly
 * testable without starting a dev server.
 */
export function createConsoleMiddleware(options: ConsoleMiddlewareOptions = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CONSOLE_BODY_BYTES;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const color = options.color ?? Boolean(process.stdout.isTTY);

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://fen.local").pathname;
    } catch {
      next();
      return;
    }
    if (pathname !== FEN_CONSOLE_ENDPOINT) {
      next();
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, "console endpoint requires POST");
      return;
    }
    if (!trustedClient(req)) {
      respond(res, 403, "console route is served to loopback/tailnet clients only");
      return;
    }
    if (!sameOrigin(req)) {
      respond(res, 403, "console route is same-origin only");
      return;
    }

    const contentLength = req.headers["content-length"];
    if (typeof contentLength === "string" && Number(contentLength) > maxBodyBytes) {
      destroyRequest(req);
      respond(res, 413, "console payload too large");
      return;
    }

    void readBody(req, maxBodyBytes)
      .then((body) => {
        const batch = parseBatch(body);
        if (batch === undefined) {
          respond(res, 400, "malformed console payload");
          return;
        }
        for (const entry of batch) {
          try {
            sink(formatEntry(entry, color));
          } catch {
            // A logging sink must not turn a successful browser report into a
            // crashed dev-server request.
          }
        }
        respond(res, 204);
      })
      .catch((error: unknown) => {
        respond(res, error instanceof BodyTooLargeError ? 413 : 400, error instanceof BodyTooLargeError ? "console payload too large" : "invalid console request");
      });
  };
}

/**
 * Installed only by the Vite serve plugin. It observes the original console
 * methods before the app's diagnostics wrapper is loaded, then always calls
 * those methods so both observation layers coexist.
 */
export const FEN_CONSOLE_CLIENT_SNIPPET = String.raw`(() => {
  try {
    const w = window;
    if (w.__fenConsoleForwarding) return;
    w.__fenConsoleForwarding = true;
    const endpoint = "/__fen/console";
    const queue = [];
    let flushing = false;
    let disabled = false;
    let consecutiveFailures = 0;
    const maxText = 512;
    const maxArgs = 10;
    const flushThreshold = 8;
    const maxQueue = 1000;
    // Reserve one queue slot so a dropped-count marker always fits.
    const queueCapacity = maxQueue - 1;
    const maxBodyBytes = 64 * 1024;
    // Keep every request strictly below the server's cap, including [] and
    // comma/bracket overhead around each serialized entry.
    const maxBatchBytes = maxBodyBytes - 1;
    const maxEntryBytes = maxBatchBytes - 2;
    const maxConsecutiveFailures = 3;
    let droppedCount = 0;

    const utf8Bytes = (text) => {
      try {
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
      } catch (_) {}
      let bytes = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            bytes += 4;
            index += 1;
          } else bytes += 3;
        } else bytes += 3;
      }
      return bytes;
    };

    const safe = (value, depth, seen) => {
      try {
        if (value === undefined) return "[undefined]";
        if (value === null || typeof value === "boolean" || typeof value === "number") return value;
        if (typeof value === "string") return value.slice(0, maxText);
        if (typeof value === "bigint") return String(value) + "n";
        if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
        if (typeof value === "symbol") return String(value);
        if (depth > 3) return "[depth]";
        if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
        if (typeof value !== "object") return "[unserializable]";
        if (seen.indexOf(value) !== -1) return "[Circular]";
        const nextSeen = seen.concat(value);
        const result = Object.create(null);
        Object.keys(value).slice(0, 12).forEach((key) => {
          try { result[key] = safe(value[key], depth + 1, nextSeen); } catch (_) { result[key] = "[unreadable]"; }
        });
        return result;
      } catch (_) {
        return "[unreadable]";
      }
    };

    const stackOf = (args) => {
      for (const value of args) {
        try {
          if (value && typeof value.stack === "string") return value.stack.slice(0, 4096);
        } catch (_) {}
      }
      return undefined;
    };

    const serializedMarker = () => JSON.stringify({ level: "log", args: ["[truncated]"] });
    const serializeEntry = (entry) => {
      let encoded;
      try { encoded = JSON.stringify(entry); } catch (_) { encoded = undefined; }
      if (typeof encoded === "string" && utf8Bytes(encoded) <= maxEntryBytes) return encoded;

      const truncated = {
        level: entry.level,
        args: ["[truncated]"],
        ts: entry.ts,
      };
      if (typeof entry.stack === "string") truncated.stack = "[truncated]";
      try {
        encoded = JSON.stringify(truncated);
      } catch (_) {
        encoded = undefined;
      }
      if (typeof encoded === "string" && utf8Bytes(encoded) <= maxEntryBytes) return encoded;
      return serializedMarker();
    };

    const markerEntry = (count) => serializeEntry({
      level: "warn",
      args: ["[web] " + count + " entries dropped"],
      ts: Date.now(),
    });

    const chunkBodies = (entries) => {
      const bodies = [];
      let current = "[";
      let currentBytes = 1;
      for (const encoded of entries) {
        const entryBytes = utf8Bytes(encoded);
        const separatorBytes = currentBytes === 1 ? 0 : 1;
        const candidateBytes = currentBytes + separatorBytes + entryBytes + 1;
        if (currentBytes !== 1 && candidateBytes > maxBatchBytes) {
          bodies.push(current + "]");
          current = "[" + encoded;
          currentBytes = 1 + entryBytes;
        } else {
          current += (separatorBytes === 0 ? "" : ",") + encoded;
          currentBytes += separatorBytes + entryBytes;
        }
      }
      if (currentBytes !== 1) bodies.push(current + "]");
      return bodies;
    };

    const notePostResult = (ok) => {
      if (ok) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) disabled = true;
    };

    const post = (body) => {
      try {
        if (navigator.sendBeacon && typeof Blob === "function" && navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }))) {
          // Keep accepted beacon sends synchronous so pagehide can hand off
          // every chunk before the document starts unloading.
          return true;
        }
      } catch (_) {}
      try {
        const request = fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "same-origin" });
        return Promise.resolve(request)
          .then((response) => !response || response.ok !== false)
          .catch(() => false);
      } catch (_) {
        return Promise.resolve(false);
      }
    };

    const finish = () => {
      flushing = false;
      if (!disabled && queue.length >= flushThreshold) flush();
    };

    const sendBodies = (bodies, index) => {
      while (!disabled && index < bodies.length) {
        const result = post(bodies[index]);
        if (typeof result === "boolean") {
          notePostResult(result);
          index += 1;
          continue;
        }
        result.then((ok) => {
          notePostResult(ok);
          sendBodies(bodies, index + 1);
        }).catch(() => {
          notePostResult(false);
          sendBodies(bodies, index + 1);
        });
        return;
      }
      finish();
    };

    const enqueue = (level, args, stack) => {
      try {
        if (disabled) return;
        if (queue.length >= queueCapacity) {
          droppedCount += 1;
          return;
        }
        queue.push(serializeEntry({
          level,
          args: args.slice(0, maxArgs).map((value) => safe(value, 0, [])),
          stack,
          ts: Date.now(),
        }));
        if (queue.length >= flushThreshold) flush();
      } catch (_) {}
    };

    function flush() {
      if (flushing || disabled) return;
      if (droppedCount > 0) {
        queue.push(markerEntry(droppedCount));
        droppedCount = 0;
      }
      if (queue.length === 0) return;
      flushing = true;
      const batch = queue.splice(0, queue.length);
      let bodies;
      try {
        bodies = chunkBodies(batch);
      } catch (_) {
        notePostResult(false);
        finish();
        return;
      }
      sendBodies(bodies, 0);
    }

    w.setInterval(flush, 1000);
    w.addEventListener("pagehide", flush);

    ["debug", "info", "log", "warn", "error", "trace"].forEach((level) => {
      try {
        const original = console[level];
        if (typeof original !== "function") return;
        console[level] = function () {
          const args = Array.prototype.slice.call(arguments);
          try { enqueue(level, args, stackOf(args)); } catch (_) {}
          return original.apply(this, arguments);
        };
      } catch (_) {}
    });

    const previousOnError = w.onerror;
    w.onerror = function (message, source, lineno, colno, error) {
      try { enqueue("error", [message, source, lineno, colno, error], stackOf([error])); } catch (_) {}
      if (typeof previousOnError === "function") {
        try { return previousOnError.apply(this, arguments); } catch (_) {}
      }
      return false;
    };
    w.addEventListener("unhandledrejection", (event) => {
      try { enqueue("error", ["Unhandled promise rejection", event.reason], stackOf([event.reason])); } catch (_) {}
    });
  } catch (_) {}
})();`;
