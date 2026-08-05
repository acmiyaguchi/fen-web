// Opt-in end-to-end harness: runs ONE REAL agent turn through the
// fen-web stack against OpenAI Codex (the ChatGPT-subscription
// `openai-codex` provider), reusing the user's existing fen OAuth
// credentials in `~/.config/fen/auth.json`.
//
// This is a *script*, not a test: it is never picked up by `npm test`
// (which only runs `dist/**/*.test.js`) or CI. Run it explicitly:
//
//   npm run build && npm run e2e:codex
//
// It is opt-in and network-touching by design -- it validates the real
// stack (real wasmoon, real fetch, real filesystem-backed auth) against
// a live provider, unlike turn.test.ts's fully scripted/stubbed run.
//
// Guards:
//  - Exits 0 with a "skipped" message if auth.json is missing or has no
//    openai-codex record. Never fails CI/dev flow by accident.
//  - NEVER prints token contents, Authorization headers, or raw
//    auth.json contents. Only structural facts (booleans, counts,
//    timings) are logged.
//
// Design notes (see turn.test.ts / turnScript.fnl for the stubbed
// sibling this borrows its shape from):
//
//  - Real provider registration mirrors fen's own
//    fen/extensions/adapters/providers/openai/init.fnl: an
//    `openai-codex` auth-backend (configured?/get-fresh-creds!) plus an
//    `openai-codex` provider backed by openai_codex_responses.fnl. We
//    add these under their real dotted module names by hand (same
//    "manual entries" pattern turn.test.ts's buildSources() uses for
//    openai_completions), rather than pulling in init.fnl itself (which
//    would also drag in the PKCE login/keychain CLI-login flow this
//    harness has no use for).
//  - fs_kv shims (packages/platform/fnl/fen_web/shims/fs_kv.fnl) are
//    DELIBERATELY NOT installed here: they monkey-patch io.open/
//    os.getenv, which would break openai_codex_keychain.fnl's real
//    filesystem read of auth.json. Under wasmoon-on-Node, Lua's
//    io.open/os.getenv reach the real OS filesystem/environment
//    natively, so fen's own auth stack works completely unmodified.
//  - The session backend still uses the sync table-backed kv (as
//    turnScript.fnl's does) -- that one is fen-web's own code, not
//    fen's auth stack, and is fine to stub.
//  - The fetch host is wired to a real FetchPoller over WebHostFetch
//    (Node 22 global fetch), not ScriptedFetch: both the Codex
//    Responses call AND, if needed, the OAuth token-refresh POST to
//    auth.openai.com go over this real transport.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createFenRuntime, loadFenTree, type FenSource } from "@fen-web/runtime";
import { FetchPoller, WebHostFetch } from "@fen-web/bindings";

const here = path.dirname(fileURLToPath(import.meta.url));
const fenPackages = path.resolve(here, "..", "..", "..", "fen", "packages");
const fenExtensions = path.resolve(here, "..", "..", "..", "fen", "extensions");
const bindingsFnl = path.resolve(here, "..", "..", "bindings", "fnl");
const platformFnl = path.resolve(here, "..", "..", "platform", "fnl");

const PROMPT = "Reply with exactly: fen-web live turn OK";
// fen's own default model for the openai-codex provider -- see
// fen/extensions/adapters/providers/openai/init.fnl:67
// (`auth-provider-spec codex-responses :openai-codex :gpt-5.5 ...`).
// Not requested by anyone; this harness simply mirrors fen's own
// default rather than picking an arbitrary model.
const MODEL = "gpt-5.5";

function authJsonPath(): string {
  const fenAuthDir = process.env.FEN_AUTH_DIR;
  if (fenAuthDir) return path.join(fenAuthDir, "auth.json");
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "fen", "auth.json");
}

function hasCodexCreds(): boolean {
  const p = authJsonPath();
  if (!existsSync(p)) return false;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const rec = raw["openai-codex"] as { type?: string; access?: string; refresh?: string } | undefined;
    return !!(rec && rec.type === "oauth" && rec.access && rec.refresh);
  } catch {
    return false;
  }
}

/** Same source-map assembly as turn.test.ts's buildSources(), but adding
 * the real openai-codex provider family (Responses + Codex OAuth) instead
 * of the stub Chat Completions provider. */
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
    "fen.extensions.provider_openai.openai_responses_shared": path.join(
      providerOpenaiDir,
      "openai_responses_shared.fnl",
    ),
    "fen.extensions.provider_openai.openai_codex_responses": path.join(
      providerOpenaiDir,
      "openai_codex_responses.fnl",
    ),
    "fen.extensions.provider_openai.openai_codex_oauth": path.join(
      providerOpenaiDir,
      "openai_codex_oauth.fnl",
    ),
    "fen.extensions.provider_openai.openai_codex_keychain": path.join(
      providerOpenaiDir,
      "openai_codex_keychain.fnl",
    ),
    "fen.extensions.provider_shared": path.join(providerSharedDir, "init.fnl"),
    "fen.extensions.provider_shared.streaming": path.join(providerSharedDir, "streaming.fnl"),
    "fen.extensions.provider_shared.retry": path.join(providerSharedDir, "retry.fnl"),
  };
  for (const [modname, file] of Object.entries(manual)) {
    sources.set(modname, { lang: "fnl", src: readFileSync(file, "utf8") });
  }

  sources.set("fen_web_integration.e2e_codex_script", {
    lang: "fnl",
    src: E2E_SCRIPT,
  });

  return sources;
}

/** Synchronous table-backed host.kv, identical in shape to
 * turn.test.ts's makeSyncKv -- used only for the session backend, never
 * for auth. */
function makeSyncKv() {
  const store = new Map<string, string>();
  return {
    sync: true as const,
    get: (key: string) => store.get(key),
    put: (key: string, value: string) => {
      store.set(key, value);
    },
    delete: (key: string) => {
      store.delete(key);
    },
    list: (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    store,
  };
}

/** Real fetch host: FetchPoller backed by WebHostFetch (Node 22 global
 * fetch). No CORS restrictions under Node, so both the Codex Responses
 * API call and the auth.openai.com token-refresh POST (if the stored
 * token needs refreshing) go over this real transport. */
function makeRealFetchHost() {
  const poller = new FetchPoller(new WebHostFetch());
  return {
    fetch_start: (opts: unknown) => poller.start(opts as never),
    fetch_poll: (id: number) => poller.poll(id),
    fetch_dispose: (id: number) => poller.dispose(id),
  };
}

/**
 * RUNTIME GAP (discovered empirically, see report): wasmoon's `io.open`
 * does NOT reach the real host filesystem, and `os.getenv` does NOT
 * proxy real process.env. wasmoon bundles an Emscripten MEMFS virtual
 * filesystem (`HOME` reads back as the synthetic `/home/web_user`, and a
 * real-path `io.open` returns nil) -- this contradicts the assumption
 * this harness's task brief was written under. `packages/runtime`'s
 * `createFenRuntime` does not currently expose wasmoon's
 * `LuaFactory.mountFile`/`environmentVariables` knobs (they're
 * LuaFactory-constructor-time options; `FenRuntimeOptions` has no
 * equivalent).
 *
 * Rather than patching fen's `io.open`/`os.getenv` (which the task
 * explicitly rules out, since that's what the fs_kv shims do and would
 * defeat the point of exercising fen's real auth-storage code), this
 * reaches into wasmoon's own already-initialized virtual filesystem
 * (`rt.lua.cmodule.module.FS`, the same Emscripten FS object
 * `LuaFactory.mountFileSync` writes through) and mounts the *real*
 * auth.json bytes at the exact virtual path fen's own
 * openai_codex_keychain.fnl resolves via `os.getenv("HOME")` inside the
 * VM (`/home/web_user/.config/fen/auth.json`, absent a `FEN_AUTH_DIR`/
 * `XDG_CONFIG_HOME` override, which this harness also does not set,
 * since those would need the same treatment). This is wasmoon's own
 * supported FS surface, not a fen-core hack: fen's keychain module still
 * calls plain unmodified `io.open`/`os.getenv`, unaware anything unusual
 * happened underneath it.
 *
 * Known limitation: if openai_codex_oauth.fnl refreshes the token during
 * this run, the write lands only in wasmoon's in-VM copy (real
 * `os.rename`/`io.open` calls inside the sandbox are honored, but the
 * file lives in MEMFS, not on host disk). `syncAuthJsonBack` below reads
 * that in-VM copy back out and rewrites the real host file after the
 * run, so a refresh is not silently lost.
 */
// wasmoon version this FS reach-in was verified against (see
// package.json / node_modules/wasmoon/package.json). `LuaEngine.cmodule`
// and `cmodule.module.FS` are undocumented internals, not part of
// wasmoon's public TS surface -- if a wasmoon upgrade restructures them,
// getFS() below fails loudly (see its error message) rather than
// silently no-op'ing and losing the auth round-trip.
const WASMOON_VERSION_VERIFIED_AGAINST = "1.16.0";

/** Reach into wasmoon's already-initialized Emscripten virtual
 * filesystem. Asserts the expected shape is present; fails loudly
 * (rather than a confusing later TypeError) if a wasmoon upgrade moved
 * things -- see WASMOON_VERSION_VERIFIED_AGAINST above. */
function getFS(rt: Awaited<ReturnType<typeof createFenRuntime>>): {
  mkdir: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
  readFile: (path: string) => Uint8Array;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmodule = (rt.lua as any).cmodule;
  const FS = cmodule && cmodule.module && cmodule.module.FS;
  if (
    !FS ||
    typeof FS.mkdir !== "function" ||
    typeof FS.writeFile !== "function" ||
    typeof FS.readFile !== "function"
  ) {
    throw new Error(
      "e2e-codex: wasmoon internals changed -- rt.lua.cmodule.module.FS no longer has the expected " +
        `mkdir/writeFile/readFile shape (verified against wasmoon@${WASMOON_VERSION_VERIFIED_AGAINST}). ` +
        "See issue #18.",
    );
  }
  return FS;
}

/**
 * RUNTIME GAP (discovered empirically, see report): wasmoon's `io.open`
 * does NOT reach the real host filesystem, and `os.getenv` does NOT
 * proxy real process.env. wasmoon bundles an Emscripten MEMFS virtual
 * filesystem -- this contradicts the assumption this harness's task
 * brief was written under. `packages/runtime`'s `createFenRuntime` does
 * not currently expose wasmoon's `LuaFactory.mountFile`/
 * `environmentVariables` knobs (they're LuaFactory-constructor-time
 * options; `FenRuntimeOptions` has no equivalent).
 *
 * Rather than patching fen's `io.open`/`os.getenv` (which the task
 * explicitly rules out, since that's what the fs_kv shims do and would
 * defeat the point of exercising fen's real auth-storage code), this
 * reaches into wasmoon's own already-initialized virtual filesystem
 * (`rt.lua.cmodule.module.FS`, the same Emscripten FS object
 * `LuaFactory.mountFileSync` writes through) and mounts the *real*
 * auth.json bytes at whatever virtual path fen's own
 * openai_codex_keychain.fnl actually resolves via `os.getenv("HOME")`
 * inside the VM. The VM's HOME is read back with `os.getenv` rather than
 * hardcoded, since that sandboxed value is itself wasmoon-internal and
 * not something this harness should assume stays `/home/web_user`
 * forever. This is wasmoon's own supported FS surface, not a fen-core
 * hack: fen's keychain module still calls plain unmodified
 * `io.open`/`os.getenv`, unaware anything unusual happened underneath
 * it.
 *
 * Known limitation: if openai_codex_oauth.fnl refreshes the token during
 * this run, the write lands only in wasmoon's in-VM copy (real
 * `os.rename`/`io.open` calls inside the sandbox are honored, but the
 * file lives in MEMFS, not on host disk). `syncAuthJsonBack` below reads
 * that in-VM copy back out and merges just the `openai-codex` record
 * into the real host file after the run, so a refresh is not silently
 * lost -- see its own doc comment for why this must be a merge, not a
 * whole-file overwrite.
 */
async function mountRealAuthJson(rt: Awaited<ReturnType<typeof createFenRuntime>>): Promise<{
  virtualPath: string;
  hostPath: string;
}> {
  const hostPath = authJsonPath();
  const FS = getFS(rt);

  const vmHome = await rt.doString(`return os.getenv("HOME")`);
  if (typeof vmHome !== "string" || vmHome === "") {
    throw new Error(
      "e2e-codex: in-VM os.getenv(\"HOME\") returned nil/empty -- cannot compute the virtual auth.json path.",
    );
  }
  const virtualDir = `${vmHome}/.config/fen`;
  const virtualPath = `${virtualDir}/auth.json`;

  for (const dir of [vmHome, `${vmHome}/.config`, virtualDir]) {
    try {
      FS.mkdir(dir);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
    }
  }
  FS.writeFile(virtualPath, readFileSync(hostPath));
  return { virtualPath, hostPath };
}

/**
 * Reads the (possibly refresh-rewritten) auth.json back out of wasmoon's
 * virtual FS and, if the `openai-codex` record actually changed, merges
 * *only that key* back into a freshly re-read copy of the real host
 * file -- never a blind whole-file snapshot overwrite, which would
 * clobber any concurrent update to some other provider's record in
 * auth.json made outside this VM while the turn was running. Writes
 * atomically, mirroring fen's own openai_codex_keychain.fnl `save`
 * (tmp file at 0o600, then rename over the real path) rather than
 * writing the real path in place. Never logs file contents.
 *
 * Returns "unchanged", "merged", or "malformed" (VM-side JSON failed to
 * parse -- treated as no-op, not a crash, since a malformed write is
 * exactly the kind of thing a tmp+rename is meant to guard the *real*
 * file against).
 */
function syncAuthJsonBack(
  rt: Awaited<ReturnType<typeof createFenRuntime>>,
  mount: { virtualPath: string; hostPath: string },
): "unchanged" | "merged" | "malformed" {
  const FS = getFS(rt);
  const vmBytes = FS.readFile(mount.virtualPath);

  let vmAuth: Record<string, unknown>;
  try {
    vmAuth = JSON.parse(Buffer.from(vmBytes).toString("utf8"));
  } catch {
    return "malformed";
  }
  const vmRecord = vmAuth["openai-codex"];
  if (vmRecord === undefined) return "malformed";

  const hostAuth: Record<string, unknown> = JSON.parse(readFileSync(mount.hostPath, "utf8"));
  if (JSON.stringify(hostAuth["openai-codex"]) === JSON.stringify(vmRecord)) {
    return "unchanged";
  }

  const merged = { ...hostAuth, "openai-codex": vmRecord };
  const tmpPath = `${mount.hostPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged), { mode: 0o600 });
  renameSync(tmpPath, mount.hostPath);
  return "merged";
}

async function installFetchBackend(rt: Awaited<ReturnType<typeof createFenRuntime>>) {
  const src = readFileSync(path.join(bindingsFnl, "fen", "util", "http", "backends", "fetch.fnl"), "utf8");
  rt.lua.global.set("__fetch_backend_src", src);
  await rt.doString(`
    local compiled = assert(fennel.compileString(__fetch_backend_src,
      {filename = "fen.util.http.backend", ["module-name"] = "fen.util.http.backend"}))
    local chunk = assert(load(compiled, "@fen.util.http.backend", "t"))
    package.loaded["fen.util.http.backend"] = chunk()
  `);
}

// Orchestration script run inside the coroutine pump, mirroring
// turnScript.fnl but registering the real `openai-codex` auth-backend +
// provider (per fen/extensions/adapters/providers/openai/init.fnl)
// instead of the stub Chat Completions provider. Deliberately does NOT
// require provider_openai's own init.fnl/manifest (that also pulls in
// the PKCE login/CLI keychain flow this harness has no use for) -- it
// requires openai_codex_responses.fnl + openai_codex_oauth.fnl directly
// and registers them by hand, same pattern turnScript.fnl uses for
// openai_completions.
//
// No hardcoded model default here: `opts.model` is always supplied by
// main() (derived from the single `MODEL` const above), so there is only
// one place in this file that names a model.
const E2E_SCRIPT = `
(local api-factory (require :fen.core.extensions.loader.api))
(local sessions-init (require :fen_web.sessions))
(local codex-responses (require :fen.extensions.provider_openai.openai_codex_responses))
(local codex-auth (require :fen.extensions.provider_openai.openai_codex_oauth))
(local session-backend-registry (require :fen.core.extensions.register.session_backend))
(local agent-mod (require :fen.core.agent))

;; Mirrors init.fnl's auth-provider-spec shape: copy the provider table,
;; set :name/:default-model/:auth-backend.
(fn codex-provider-spec [default-model]
  (let [spec {}]
    (each [k v (pairs codex-responses)] (tset spec k v))
    (set spec.name :openai-codex)
    (set spec.default-model default-model)
    (set spec.auth-backend :openai-codex)
    spec))

(fn run [opts]
  (let [api (api-factory.make-api :fen-web-e2e-codex nil {:privileged? true})
        _reg-auth (api.register :auth-backend
                    {:name :openai-codex
                     :description "ChatGPT subscription PKCE OAuth credentials stored in fen's auth.json."
                     :configured? codex-auth.configured?
                     :get-fresh-creds! codex-auth.get-fresh-creds!})
        _reg-provider (api.register :provider (codex-provider-spec opts.model))
        _reg-session (sessions-init.register api)
        _active (session-backend-registry.set-active! :kv)
        backend (session-backend-registry.find :kv)
        session (backend.open (or opts.cwd "/fen-web-e2e-codex"))
        events []
        agent (agent-mod.make-agent
                {:provider-name :openai-codex
                 :model opts.model
                 :system (or opts.system "You are a test assistant.")
                 :api-key "unused-codex-uses-oauth"
                 :max-tokens 256
                 :on-event (fn [ev] (table.insert events (or ev.type "?")))})
        start-ms (os.clock)
        reply (agent-mod.step agent opts.prompt)
        elapsed-s (- (os.clock) start-ms)]
    (each [_ m (ipairs agent.messages)]
      (backend.append session m))
    (backend.close session)
    {:reply reply
     :events events
     :session-id session.id
     :message-count (length agent.messages)
     :elapsed-s elapsed-s}))

{: run}
`;

function redactError(err: unknown): string {
  // Defensive redaction: never let a bearer token, refresh token, or raw
  // auth.json content escape into stdout/stderr. Errors surfaced by
  // fen's http/auth modules interpolate response bodies and headers
  // directly, so scrub anything that looks like a token or auth header.
  let msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  // auth.json / stored-record shape (openai_codex_keychain.fnl).
  msg = msg.replace(/"access"\s*:\s*"[^"]*"/gi, '"access":"[REDACTED]"');
  msg = msg.replace(/"refresh"\s*:\s*"[^"]*"/gi, '"refresh":"[REDACTED]"');
  msg = msg.replace(/"accountId"\s*:\s*"[^"]*"/gi, '"accountId":"[REDACTED]"');
  // OAuth wire shapes: the refresh POST body (form-encoded) and the
  // token-endpoint JSON response (openai_codex_oauth.fnl:105's
  // `refresh!`, which decodes access_token/refresh_token/id_token from
  // JSON, not just the form-encoded request side).
  msg = msg.replace(/access_token"\s*:\s*"[^"]*"/gi, 'access_token":"[REDACTED]"');
  msg = msg.replace(/refresh_token"\s*:\s*"[^"]*"/gi, 'refresh_token":"[REDACTED]"');
  msg = msg.replace(/id_token"\s*:\s*"[^"]*"/gi, 'id_token":"[REDACTED]"');
  msg = msg.replace(/refresh_token=[^&\s"]+/gi, "refresh_token=[REDACTED]");
  msg = msg.replace(/chatgpt-account-id[^\n,}]*/gi, "chatgpt-account-id: [REDACTED]");
  return msg;
}

async function main() {
  if (!hasCodexCreds()) {
    console.log(
      `skipped: no usable openai-codex OAuth record found at ${authJsonPath()} ` +
        `(run \`fen --login openai-codex\` first, or set FEN_AUTH_DIR)`,
    );
    process.exit(0);
  }

  console.log("fen-web e2e-codex: found openai-codex credentials, booting runtime...");

  const kv = makeSyncKv();
  const rt = await createFenRuntime({
    sources: buildSources(),
    host: {
      kv,
      ...makeRealFetchHost(),
    },
  });

  // Populated once mountRealAuthJson succeeds; syncAuthJsonBack in the
  // `finally` below only runs if this got set, so a failure before the
  // mount (e.g. the FS-shape assertion in getFS) doesn't try to sync a
  // path that was never mounted.
  let authMount: { virtualPath: string; hostPath: string } | undefined;

  try {
    await installFetchBackend(rt);

    // Runtime gap: wasmoon's io library does not implement io.popen (no
    // subprocess support in a WASM Lua VM). openai_codex_responses.fnl's
    // detect-user-agent calls `io.popen "uname -s -r -m ..."` once at
    // module load time to build a cosmetic User-Agent string, and already
    // falls back cleanly to `"pi (lua)"` when the pipe is nil/unavailable
    // -- exactly the "uname missing" case that comment anticipates. This
    // stub supplies that nil return so the real fallback path runs,
    // rather than patching fen's module. It does NOT touch io.open or
    // os.getenv, so auth.json/env reads stay on the real filesystem.
    //
    // os.execute is stubbed alongside it for the same reason: wasmoon
    // doesn't support subprocess execution, and
    // openai_codex_keychain.fnl's `save` path (exercised only if a token
    // refresh happens during this run) calls `os.execute("chmod 600 ...")`
    // via chmod-private! -- unexercised in the "token already fresh" case
    // turn.test.ts-style runs hit most often, but it would die on a nil
    // call the moment a refresh does happen. Returning true mimics a
    // successful chmod; the real host-side permission tightening still
    // happens for real when syncAuthJsonBack below writes the merged
    // record back out (0o600 on the tmp file before rename).
    await rt.doString(`
      io.popen = function() return nil end
      os.execute = function() return true end
    `);

    authMount = await mountRealAuthJson(rt);

    rt.lua.global.set("__e2e_opts", {
      cwd: "/fen-web-e2e-codex",
      model: MODEL,
      system: "You are a test assistant. Follow instructions exactly.",
      prompt: PROMPT,
    });

    const wallStart = performance.now();
    const pump = await rt.createCoroutinePump(`
      function()
        return (require "fen_web_integration.e2e_codex_script").run(__e2e_opts)
      end
    `);

    let status = "suspended";
    let pumps = 0;
    // A real network round-trip (connect + TLS + streamed SSE) takes
    // orders of magnitude longer than the scripted-stub turn.test.ts
    // sizes its MAX_PUMPS for (500), so this budget is much larger. Each
    // pump() is a cheap coroutine resume that returns immediately when
    // the fetch promise hasn't settled yet (see host-protocol.md's
    // poll/yield loop), so spinning through many of them is fine -- but
    // add a short delay every so often so this doesn't peg a CPU core
    // while genuinely waiting on the network.
    const MAX_PUMPS = 100_000;
    while (status === "suspended" && pumps < MAX_PUMPS) {
      status = await pump.pump();
      pumps += 1;
      if (pumps % 50 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const wallMs = performance.now() - wallStart;

    if (status !== "dead") {
      console.error(`FAILED: coroutine did not finish within ${MAX_PUMPS} pumps (status=${status})`);
      process.exit(1);
    }

    const result = (await pump.result()) as Record<string, unknown> as {
      reply: string;
      events: string[];
      "session-id": string;
      "message-count": number;
      "elapsed-s": number;
    };

    // agent.step returns the plain final visible text (a Lua string),
    // not a structured AssistantMessage -- see fen/packages/core/src/
    // fen/core/agent.fnl's step-loop, which sets `final` to
    // `(types.assistant-text asst)` on a natural stop.
    const replyText = result.reply;

    console.log("");
    console.log("=== fen-web live Codex turn: OK ===");
    console.log(`Assistant reply: ${JSON.stringify(replyText)}`);
    console.log(`Events: ${JSON.stringify(result.events)}`);
    console.log(`Turn latency (Lua os.clock): ${result["elapsed-s"].toFixed(3)}s`);
    console.log(`Turn latency (wall clock, incl. coroutine pump overhead): ${(wallMs / 1000).toFixed(3)}s`);
    console.log(`Session id: ${result["session-id"]}, messages recorded: ${result["message-count"]}`);

    // Verify the session backend actually recorded the turn in kv.
    const sessionKeys = [...kv.store.keys()].filter((k) => k.startsWith(`session:${result["session-id"]}:`));
    const hasMeta = sessionKeys.some((k) => k.endsWith(":meta"));
    const entryKeys = sessionKeys.filter((k) => k.includes(":entry:"));
    console.log(
      `Session kv check: meta key present=${hasMeta}, entry count=${entryKeys.length} ` +
        `(expect 2: user+assistant)`,
    );

    if (!replyText.includes("fen-web live turn OK")) {
      console.warn(
        "WARNING: model reply did not contain the exact requested string -- " +
          "provider call succeeded, but the model did not follow the instruction verbatim.",
      );
    }
    if (!hasMeta || entryKeys.length !== 2) {
      console.error("FAILED: session backend did not record the turn as expected.");
      process.exit(1);
    }

    console.log("");
    console.log("Result: PASS");
  } catch (err) {
    console.error("FAILED: e2e-codex turn errored.");
    console.error(redactError(err));
    process.exit(1);
  } finally {
    // Runs on every exit path -- success, the pump-timeout early exit,
    // the kv-assertion early exit, and the catch block above -- so a
    // successful token refresh followed by ANY later failure still gets
    // its rotated tokens persisted before the (already server-invalidated)
    // old refresh token is lost for good. Guarded by its own try/catch so
    // a sync failure surfaces as a clear warning instead of masking
    // whatever error (if any) is already propagating out of this
    // function, and instead of throwing past `rt.close()`.
    if (authMount) {
      try {
        const outcome = syncAuthJsonBack(rt, authMount);
        if (outcome === "merged") {
          console.log(
            "Note: openai-codex credentials were refreshed during this run; " +
              `merged the refreshed record back into ${authMount.hostPath} (contents not logged).`,
          );
        } else if (outcome === "malformed") {
          console.error(
            "WARNING: could not read back a well-formed openai-codex record from the in-VM " +
              `auth.json copy at ${authMount.virtualPath} -- if a refresh happened this run, ` +
              "it may not have been persisted. The real host auth.json was left untouched.",
          );
        }
      } catch (syncErr) {
        console.error("WARNING: failed to sync auth.json back to the real host file.");
        console.error(redactError(syncErr));
      }
    }
    rt.close();
  }
}

main().catch((err) => {
  console.error(redactError(err));
  process.exit(1);
});
