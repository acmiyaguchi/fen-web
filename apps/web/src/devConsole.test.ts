import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticsBuffer } from "./diagnostics.js";
import {
  createConsoleMiddleware,
  FEN_CONSOLE_CLIENT_SNIPPET,
  FEN_CONSOLE_ENDPOINT,
  MAX_CONSOLE_BODY_BYTES,
} from "./devConsole.js";

type MockResponse = {
  statusCode: number;
  body?: string;
  ended: boolean;
  headers: Map<string, string>;
};

type ResponseStub = MockResponse & {
  setHeader(name: string, value: number | string | readonly string[]): ResponseStub;
  end(body?: string): ResponseStub;
};

function makeResponse(): ResponseStub {
  const response = {
    statusCode: 200,
    ended: false,
    headers: new Map<string, string>(),
  } as ResponseStub;
  response.setHeader = (name: string, value: number | string | readonly string[]) => {
    response.headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
    return response;
  };
  response.end = (body?: string) => {
    response.body = body;
    response.ended = true;
    return response;
  };
  return response;
}

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
  method = "POST",
  includeContentLength = true,
): EventEmitter & IncomingMessage & { destroyedByTest?: boolean } {
  const request = new EventEmitter() as EventEmitter & IncomingMessage & { destroyedByTest?: boolean };
  const requestHeaders = { ...headers };
  if (includeContentLength) requestHeaders["content-length"] = String(Buffer.byteLength(body));
  Object.assign(request, {
    url: FEN_CONSOLE_ENDPOINT,
    method,
    headers: requestHeaders,
    socket: { remoteAddress },
    resume: () => request,
    destroy: () => {
      request.destroyedByTest = true;
      return request;
    },
  });
  return request;
}

async function dispatch(
  body: string,
  options: {
    headers?: Record<string, string>;
    remoteAddress?: string;
    method?: string;
    contentLength?: boolean;
    chunks?: string[];
  } = {},
) {
  const lines: string[] = [];
  const response = makeResponse();
  const request = makeRequest(
    body,
    options.headers,
    options.remoteAddress,
    options.method,
    options.contentLength ?? true,
  );
  let nextCalls = 0;
  createConsoleMiddleware({ sink: (line) => lines.push(line), color: false })(
    request,
    response as unknown as ServerResponse,
    () => {
      nextCalls += 1;
    },
  );
  for (const chunk of options.chunks ?? [body]) request.emit("data", chunk);
  request.emit("end");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { lines, response, nextCalls, request };
}

test("console middleware prints a valid batch through its injected sink", async () => {
  const result = await dispatch(
    JSON.stringify([
      { level: "log", args: ["hello", { count: 2 }], ts: 123 },
      { level: "error", args: ["boom"], stack: "Error: boom\\n    at app.js:1:2" },
    ]),
  );

  assert.equal(result.response.statusCode, 204);
  assert.equal(result.response.body, undefined);
  assert.equal(result.nextCalls, 0);
  assert.deepEqual(result.lines, [
    '[web:log] "hello" {"count":2}',
    '[web:error] "boom"\nError: boom\\n    at app.js:1:2',
  ]);
});

test("stack controls are neutralized and stack lines cannot forge web log entries", async () => {
  const forged = "[web:error] forged";
  const result = await dispatch(JSON.stringify([
    { level: "error", args: ["boom"], stack: `Error: boom\u001b[2K\n${forged}` },
  ]));

  assert.equal(result.response.statusCode, 204);
  assert.equal(result.lines.length, 1);
  const output = result.lines[0];
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes(`\n${forged}`), false);
  assert.ok(output.includes(`\n    ${forged}`));
});

test("the injected wrapper composes with the diagnostics console wrapper", () => {
  const nativeCalls: unknown[] = [];
  const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["debug", "info", "log", "warn", "error", "trace"]) {
    fakeConsole[level] = (...args: unknown[]) => nativeCalls.push({ level, args });
  }
  const pageHandlers = new Map<string, () => void>();
  const beacons: Array<{ endpoint: string; body: string }> = [];
  class FakeBlob {
    readonly body: string;

    constructor(parts: readonly unknown[]) {
      this.body = parts.map(String).join("");
    }
  }
  const window = {
    setInterval: () => 1,
    addEventListener: (name: string, handler: () => void) => pageHandlers.set(name, handler),
    onerror: null as unknown,
  };
  const navigator = {
    sendBeacon: (endpoint: string, payload: FakeBlob) => {
      beacons.push({ endpoint, body: payload.body });
      return true;
    },
  };

  runInNewContext(FEN_CONSOLE_CLIENT_SNIPPET, {
    window,
    console: fakeConsole,
    navigator,
    Blob: FakeBlob,
  });

  const diagnostics = new DiagnosticsBuffer();
  const originalLog = fakeConsole.log.bind(fakeConsole);
  fakeConsole.log = (...args: unknown[]) => {
    originalLog(...args);
    diagnostics.recordHostConsole("log", args);
  };
  fakeConsole.log("both layers", { ok: true });
  pageHandlers.get("pagehide")?.();

  assert.equal(nativeCalls.length, 1);
  assert.match(diagnostics.snapshot(), /both layers/);
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].endpoint, FEN_CONSOLE_ENDPOINT);
  assert.match(beacons[0].body, /both layers/);
});

test("client forwarding truncates entries and chunks batches below the server cap", async () => {
  const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["debug", "info", "log", "warn", "error", "trace"]) {
    fakeConsole[level] = () => {};
  }
  const pageHandlers = new Map<string, () => void>();
  const beacons: Array<{ endpoint: string; body: string }> = [];
  class FakeBlob {
    readonly body: string;

    constructor(parts: readonly unknown[]) {
      this.body = parts.map(String).join("");
    }
  }
  const window = {
    setInterval: () => 1,
    addEventListener: (name: string, handler: () => void) => pageHandlers.set(name, handler),
    onerror: null as unknown,
  };
  const navigator = {
    sendBeacon: (endpoint: string, payload: FakeBlob) => {
      beacons.push({ endpoint, body: payload.body });
      return true;
    },
  };

  runInNewContext(FEN_CONSOLE_CLIENT_SNIPPET, {
    window,
    console: fakeConsole,
    navigator,
    Blob: FakeBlob,
  });

  const wide = (depth: number): unknown => {
    if (depth === 0) return "x".repeat(512);
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 12; index += 1) value[`key${index}`] = wide(depth - 1);
    return value;
  };
  const huge = wide(3);
  const regular = wide(1);
  fakeConsole.log(huge);
  for (let index = 0; index < 18; index += 1) fakeConsole.log(regular);
  pageHandlers.get("pagehide")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(beacons.length > 1);
  for (const beacon of beacons) {
    assert.equal(beacon.endpoint, FEN_CONSOLE_ENDPOINT);
    assert.ok(Buffer.byteLength(beacon.body) < MAX_CONSOLE_BODY_BYTES);
  }
  const delivered = beacons.flatMap(({ body }) => JSON.parse(body) as Array<Record<string, unknown>>);
  assert.equal(delivered.length, 19);
  assert.ok(delivered.some((entry) => JSON.stringify(entry).includes("[truncated]")));
});

test("client queue cap reports entries dropped while a flush is in flight", async () => {
  const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["debug", "info", "log", "warn", "error", "trace"]) {
    fakeConsole[level] = () => {};
  }
  const requests: string[] = [];
  const pending: Array<(response: { ok: boolean }) => void> = [];
  class FakeBlob {
    constructor(readonly parts: readonly unknown[]) {}
  }
  const window = {
    setInterval: () => 1,
    addEventListener: () => {},
    onerror: null as unknown,
  };
  const navigator = { sendBeacon: () => false };
  const fetch = (_endpoint: string, init: { body?: unknown }) => new Promise<{ ok: boolean }>((resolve) => {
    requests.push(String(init.body));
    pending.push(resolve);
  });

  runInNewContext(FEN_CONSOLE_CLIENT_SNIPPET, {
    window,
    console: fakeConsole,
    navigator,
    Blob: FakeBlob,
    fetch,
  });

  for (let index = 0; index < 8; index += 1) fakeConsole.log("initial");
  for (let index = 0; index < 1100; index += 1) fakeConsole.log("queued");
  assert.equal(requests.length, 1);
  const first = pending.shift();
  assert.ok(first);
  first({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 2);
  const second = pending.shift();
  assert.ok(second);
  second({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const delivered = requests.flatMap((body) => JSON.parse(body) as Array<Record<string, unknown>>);
  assert.equal(delivered.length, 1008);
  assert.match(requests[1], /\[web\] 101 entries dropped/);
});

test("client forwarding backs off permanently after consecutive POST failures", async () => {
  const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["debug", "info", "log", "warn", "error", "trace"]) {
    fakeConsole[level] = () => {};
  }
  let requests = 0;
  class FakeBlob {
    constructor(readonly parts: readonly unknown[]) {}
  }
  const window = {
    setInterval: () => 1,
    addEventListener: () => {},
    onerror: null as unknown,
  };
  const navigator = { sendBeacon: () => false };
  const fetch = () => {
    requests += 1;
    return Promise.resolve({ ok: false });
  };

  runInNewContext(FEN_CONSOLE_CLIENT_SNIPPET, {
    window,
    console: fakeConsole,
    navigator,
    Blob: FakeBlob,
    fetch,
  });

  for (let batch = 0; batch < 4; batch += 1) {
    for (let index = 0; index < 8; index += 1) fakeConsole.log("failure");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requests, 3);
});

test("console middleware rejects oversized bodies before parsing", async () => {
  const body = "x".repeat(MAX_CONSOLE_BODY_BYTES + 1);
  const result = await dispatch(body);

  assert.equal(result.response.statusCode, 413);
  assert.match(result.response.body ?? "", /too large/);
  assert.equal(result.request.destroyedByTest, true);
  assert.deepEqual(result.lines, []);
});

test("console middleware rejects cross-site and opaque origins", async () => {
  const fetchMetadataResult = await dispatch("[]", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  const originResult = await dispatch("[]", {
    headers: { origin: "https://127.0.0.1:5173", host: "127.0.0.1:5173" },
  });
  const opaqueOriginResult = await dispatch("[]", {
    headers: { origin: "null", "sec-fetch-site": "same-origin" },
  });

  for (const result of [fetchMetadataResult, originResult, opaqueOriginResult]) {
    assert.equal(result.response.statusCode, 403);
    assert.match(result.response.body ?? "", /same-origin/);
    assert.deepEqual(result.lines, []);
  }
});

test("console middleware applies the client trust gate", async () => {
  const loopback = await dispatch("[]", { remoteAddress: "127.0.0.1" });
  const lan = await dispatch("[]", { remoteAddress: "192.168.1.20" });

  assert.equal(loopback.response.statusCode, 204);
  assert.equal(lan.response.statusCode, 403);
  assert.match(lan.response.body ?? "", /loopback\/tailnet/);
  assert.deepEqual(lan.lines, []);
});

test("console middleware rejects non-POST requests", async () => {
  const result = await dispatch("[]", { method: "GET" });

  assert.equal(result.response.statusCode, 405);
  assert.match(result.response.body ?? "", /requires POST/);
  assert.equal(result.nextCalls, 0);
  assert.deepEqual(result.lines, []);
});

test("console middleware rejects oversized chunked bodies while reading", async () => {
  const body = "x".repeat(MAX_CONSOLE_BODY_BYTES + 1);
  const result = await dispatch(body, {
    contentLength: false,
    chunks: [body.slice(0, MAX_CONSOLE_BODY_BYTES), body.slice(MAX_CONSOLE_BODY_BYTES)],
  });

  assert.equal(result.response.statusCode, 413);
  assert.match(result.response.body ?? "", /too large/);
  assert.equal(result.request.destroyedByTest, true);
  assert.deepEqual(result.lines, []);
});

test("console middleware handles malformed JSON without echoing the body", async () => {
  const body = '{"secret":"do-not-echo"';
  const result = await dispatch(body);

  assert.equal(result.response.statusCode, 400);
  assert.match(result.response.body ?? "", /malformed/);
  assert.equal(result.response.body?.includes("do-not-echo"), false);
  assert.deepEqual(result.lines, []);
});
