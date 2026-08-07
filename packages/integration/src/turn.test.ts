import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFenRuntime, loadFenTree, type FenSource } from "@fen-web/runtime";
import { FetchPoller, ScriptedFetch, type FetchRequestOptions } from "@fen-web/bindings";

const here = path.dirname(fileURLToPath(import.meta.url));
const fenPackages = path.resolve(here, "..", "..", "..", "fen", "packages");
const fenExtensions = path.resolve(here, "..", "..", "..", "fen", "extensions");
const bindingsFnl = path.resolve(here, "..", "..", "bindings", "fnl");
const platformFnl = path.resolve(here, "..", "..", "platform", "fnl");

/**
 * Builds the fen-web#5 headless-turn source map: fen's core+util trees
 * (the same pair packages/runtime/src/require.test.ts proves resolves
 * `fen.core.agent`'s full 33-module subgraph), plus the fen-web platform
 * fnl tree (fen_web.* -- shims, tools, sessions), plus a handful of
 * manual entries this milestone additionally needs:
 *
 * - The OpenAI Chat Completions provider (`openai_completions.fnl`) +
 *   its `openai_model_catalog.fnl` dependency, plus the shared
 *   streaming/retry helpers. These live in
 *   fen/extensions/adapters/providers/{openai,shared} as a *flat*
 *   directory (openai_completions.fnl, not
 *   provider_openai/openai_completions.fnl) -- fen's real module names
 *   (`fen.extensions.provider_openai.openai_completions`, see that
 *   extension's rockspec `install.lua` table) come from a
 *   luarocks/rockspec build step, not from mechanically walking the
 *   directory tree the way loadFenTree does for fen's own packages/*
 *   layout. So these files are added under their real dotted names by
 *   hand rather than via loadFenTree. Deliberately not
 *   fen.extensions.provider_openai's own init.fnl/manifest: that also
 *   pulls in the Codex OAuth/keychain modules (native keychain access,
 *   PKCE login flow) this headless-turn test has no use for --
 *   turnScript.fnl registers `openai_completions` as the `:openai`
 *   provider directly instead, mirroring init.fnl's own
 *   api-key-provider-spec shape.
 * - packages/bindings/fnl's fetch backend is intentionally NOT added
 *   here under "fen.util.http.backend" -- see installFetchBackend()
 *   below, which pre-sets package.loaded the same way fen's own
 *   fen.testing.stub-http! does (packages/testing/src/fen/testing/init.fnl),
 *   rather than relying on searcher/source-map substitution.
 */
function buildSources(): Map<string, FenSource> {
  const sources = loadFenTree([
    path.join(fenPackages, "core", "src"),
    path.join(fenPackages, "util", "src"),
  ]);
  for (const platform of loadFenTree([platformFnl])) {
    sources.set(platform[0], platform[1]);
  }

  const providerOpenaiDir = path.join(fenExtensions, "adapters", "providers", "openai");
  const providerSharedDir = path.join(fenExtensions, "adapters", "providers", "shared");
  const manual: Record<string, string> = {
    "fen.extensions.provider_openai.openai_completions": path.join(
      providerOpenaiDir,
      "openai_completions.fnl",
    ),
    "fen.extensions.provider_openai.openai_model_catalog": path.join(
      providerOpenaiDir,
      "openai_model_catalog.fnl",
    ),
    "fen.extensions.provider_shared": path.join(providerSharedDir, "init.fnl"),
    "fen.extensions.provider_shared.streaming": path.join(providerSharedDir, "streaming.fnl"),
    "fen.extensions.provider_shared.retry": path.join(providerSharedDir, "retry.fnl"),
  };
  for (const [modname, file] of Object.entries(manual)) {
    sources.set(modname, { lang: "fnl", src: readFileSync(file, "utf8") });
  }

  // The orchestration script that runs inside the coroutine pump (see
  // turnScript.fnl's header comment for why it lives here, not under
  // packages/platform).
  sources.set("fen_web_integration.turn_script", {
    lang: "fnl",
    src: readFileSync(path.join(here, "..", "src", "turnScript.fnl"), "utf8"),
  });

  return sources;
}

/**
 * A synchronous, table-backed host.kv (mirrors
 * packages/platform/tests/support.fnl's make-kv, the Busted-side stand-in
 * docs/bindings/kv.md describes) plus the `sync = true` capability flag
 * fen_web.sessions.init's register guard requires. Every method here is a
 * plain JS function (no Promise), and the empirical check below proves
 * wasmoon calls it synchronously from Lua -- the fs_kv shim layer
 * (packages/platform/fnl/fen_web/shims/fs_kv.fnl) assumes exactly that.
 */
function makeSyncKv(): {
  sync: true;
  get(key: string): string | undefined;
  put(key: string, value: string): void;
  delete(key: string): void;
  list(prefix: string): string[];
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    sync: true,
    get: (key) => store.get(key),
    put: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => {
      store.delete(key);
    },
    list: (prefix) =>
      [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    store,
  };
}

/** Wires __fen_host.fetch_start/fetch_poll/fetch_dispose to a FetchPoller
 * backed by a ScriptedFetch queue, per docs/bindings/host-protocol.md. */
function makeFetchHost(scripted: ScriptedFetch) {
  const poller = new FetchPoller(scripted);
  return {
    fetch_start: (opts: unknown) => poller.start(opts as never),
    fetch_poll: (id: number) => poller.poll(id),
    fetch_dispose: (id: number) => poller.dispose(id),
  };
}

/** Pre-sets package.loaded["fen.util.http.backend"] to the real
 * bindings-fnl fetch backend, compiled in-VM -- the exact mechanism
 * fetch.fnl's header comment and fen.testing.stub-http! document (a
 * direct package.loaded assignment, not a searcher substitution), so the
 * real fen.util.http.init module (already in the source map via
 * loadFenTree of util/src) picks it up on its first require. */
async function installFetchBackend(rt: Awaited<ReturnType<typeof createFenRuntime>>) {
  const src = readFileSync(
    path.join(bindingsFnl, "fen", "util", "http", "backends", "fetch.fnl"),
    "utf8",
  );
  rt.lua.global.set("__fetch_backend_src", src);
  await rt.doString(`
    local compiled = assert(fennel.compileString(__fetch_backend_src,
      {filename = "fen.util.http.backend", ["module-name"] = "fen.util.http.backend"}))
    local chunk = assert(load(compiled, "@fen.util.http.backend", "t"))
    package.loaded["fen.util.http.backend"] = chunk()
  `);
}

/**
 * Builds the scripted SSE body for one OpenAI Chat Completions streaming
 * completion, matching exactly what
 * fen/extensions/adapters/providers/openai/openai_completions.fnl's
 * process-stream-chunk! (and make-stream-pipeline's `:done-sentinel
 * "[DONE]"`) parse:
 *
 * - Each chunk is a bare `data: {...}` frame -- no `event:` line (real
 *   OpenAI doesn't send one either; process-stream-chunk! never reads
 *   `ev.event`, only the decoded JSON body).
 * - Text deltas live at `choices[0].delta.content` (a plain JSON string;
 *   process-stream-chunk! gates on `(= (type delta.content) :string)`,
 *   so this deliberately never sends a literal JSON `null` here -- the
 *   runtime's cjson stub decodes `null` to the `cjson.null` sentinel,
 *   not Lua `nil`, and that gate exists specifically to reject it).
 * - `choices[0].tool_calls` is omitted entirely (no tool call in this
 *   turn) -- process-stream-chunk! only reads `delta.tool_calls` when
 *   present, so an absent field is the correct "no tool calls" shape,
 *   not an explicit null/empty array.
 * - The terminal chunk carries `choices[0].finish_reason: "stop"` with
 *   an empty delta -- process-stream-chunk! sets `state.saw-terminal?`
 *   here (map-stop-reason "stop" -> :stop).
 * - The stream closes with a literal `data: [DONE]` frame (no trailing
 *   JSON) -- streaming.fnl's default-process-frame checks this against
 *   `config.done-sentinel` *before* attempting json.decode, so this
 *   line is intentionally not valid JSON.
 *
 * `id`/`object`/`model`/`created` and a `role` field on the first delta
 * are real Chat Completions wire fields but process-stream-chunk! never
 * reads any of them, so they're omitted here rather than guessed at.
 */
function openaiSseChunks(replyText: string): string[] {
  const words = replyText.split(" ");
  const deltaFrames = words
    .map((w, i) => (i === 0 ? w : " " + w))
    .map(
      (content) =>
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`,
    );
  return [
    ...deltaFrames,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];
}

/**
 * Empirical check (issue #5's brief asks this be verified, not assumed):
 * wasmoon marshals a plain (non-Promise-returning) JS function set on
 * __fen_host into a Lua call that returns synchronously, with no await
 * needed on the Lua side. fs_kv.fnl (packages/platform/fnl/
 * fen_web/shims/fs_kv.fnl, still installed by web boot for the Codex
 * auth keychain) requires exactly this -- io.open et al are
 * ordinary synchronous Lua calls, and if kv.get returned a
 * promise-shaped table instead of a string, fs-kv's `(= content nil)`
 * check would silently misbehave rather than erroring loudly.
 */
test("wasmoon calls a synchronous JS __fen_host function synchronously from Lua (no await needed)", async () => {
  const rt = await createFenRuntime({
    sources: new Map(),
    host: {
      sync_probe: (x: number) => x * 2,
    },
  });
  try {
    await rt.doString(`
      local result = __fen_host.sync_probe(21)
      __sync_probe_result = result
      __sync_probe_type = type(result)
    `);
    assert.equal(rt.lua.global.get("__sync_probe_type"), "number");
    assert.equal(rt.lua.global.get("__sync_probe_result"), 42);
  } finally {
    rt.close();
  }
});

test("wasmoon UTF-8-decodes a Lua request string before the fetch stub encodes its wire body", async () => {
  const scripted = new ScriptedFetch();
  scripted.enqueue({ status: 204, chunks: [] });
  let seenOptions: FetchRequestOptions | undefined;

  const rt = await createFenRuntime({
    sources: new Map(),
    host: {
      capture_fetch: (opts: FetchRequestOptions) => {
        seenOptions = opts;
        return scripted.fetch(opts);
      },
    },
  });

  try {
    await rt.doString(`
      __fetch_result = __fen_host.capture_fetch({
        method = "POST",
        url = "https://example.com",
        body = "café —"
      })
    `);

    assert.equal(seenOptions?.body, "café —");
    assert.deepEqual(
      scripted.lastRequest?.body,
      new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xe2, 0x80, 0x94]),
    );
  } finally {
    rt.close();
  }
});

test("one headless agent turn against a stub OpenAI Chat Completions provider, driven through fen.core.agent + createCoroutinePump", async () => {
  const REPLY_TEXT = "Hello from the stub provider!";
  const scripted = new ScriptedFetch();
  scripted.enqueue({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: openaiSseChunks(REPLY_TEXT),
  });

  const kv = makeSyncKv();
  const rt = await createFenRuntime({
    sources: buildSources(),
    host: {
      kv,
      ...makeFetchHost(scripted),
    },
  });

  try {
    await installFetchBackend(rt);

    rt.lua.global.set("__test_opts", {
      cwd: "/fen-web-test",
      model: "gpt-4.1-mini",
      system: "You are a test assistant.",
      messages: ["Hello, agent!"],
    });

    const pump = await rt.createCoroutinePump(`
      function()
        return (require "fen_web_integration.turn_script").run(__test_opts)
      end
    `);

    let status = "suspended";
    let pumps = 0;
    const MAX_PUMPS = 500;
    while (status === "suspended" && pumps < MAX_PUMPS) {
      status = await pump.pump();
      pumps += 1;
    }
    assert.equal(status, "dead", `coroutine did not finish within ${MAX_PUMPS} pumps`);

    // Fennel table keys built from `:kebab-case` keywords keep their
    // dashes as literal string keys (not snake_case) -- see
    // turnScript.fnl's returned table -- so these are indexed with
    // bracket syntax, not dot access.
    const result = (await pump.result()) as Record<string, unknown> as {
      replies: string[];
      events: string[];
      "session-id": string;
      "message-count": number;
      "tools-registered?": boolean;
      "tools-register-error": string | null | undefined;
      "registered-tool-names": string[];
    };

    // 1. The returned assistant reply text matches the scripted completion.
    assert.deepEqual(result.replies, [REPLY_TEXT]);

    // No :error event should have been emitted by the agent loop.
    assert.ok(
      !result.events.includes("error"),
      `expected no error events, got: ${JSON.stringify(result.events)}`,
    );
    assert.ok(result.events.includes("llm-start"));
    assert.ok(result.events.includes("llm-end"));

    // Tool registration against the real extension-loader registry must
    // succeed cleanly instead of crashing on a tail-position multi-return
    // or a malformed tool spec. Assert the complete default workspace set;
    // web_fetch is intentionally absent because this boot does not opt in.
    assert.equal(
      result["tools-registered?"],
      true,
      `expected fen_web.tools registration to succeed, got error: ${result["tools-register-error"]}`,
    );
    assert.equal(result["tools-register-error"], undefined);
    assert.deepEqual(
      [...result["registered-tool-names"]].sort(),
      [
        "delete",
        "edit",
        "find",
        "grep",
        "ls",
        "move",
        "read",
        "tool_search",
        "write",
      ],
      "expected the default browser-native workspace tools, without web_fetch",
    );

    // 2. The session backend recorded the turn: both the user and
    // assistant messages were written into the kv store.
    const sessionKeys = [...kv.store.keys()].filter((k) =>
      k.startsWith(`session:${result["session-id"]}:`),
    );
    assert.ok(
      sessionKeys.some((k) => k.endsWith(":meta")),
      "expected a session meta key in kv",
    );
    const entryKeys = sessionKeys.filter((k) => k.includes(":entry:"));
    assert.equal(entryKeys.length, 2, `expected 2 entries (user+assistant), got ${entryKeys.length}`);

    const entries = entryKeys
      .sort()
      .map((k) => JSON.parse(kv.store.get(k) as string));
    assert.equal(entries[0].message.role, "user");
    assert.equal(entries[0].message.content, "Hello, agent!");
    assert.equal(entries[1].message.role, "assistant");
    const assistantText = entries[1].message.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    assert.equal(assistantText, REPLY_TEXT);

    assert.equal(result["message-count"], 2);
  } finally {
    rt.close();
  }
});
