import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerResponse } from "node:http";
import type { Connect } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const nodeStub = path.resolve(here, "src", "nodeBuiltinStub.ts");

/** fen's auth.json path, mirroring openai_codex_keychain.fnl's resolution
 * order: FEN_AUTH_DIR, then ${XDG_CONFIG_HOME:-~/.config}/fen. */
function fenAuthPath(): string {
  const dir =
    process.env.FEN_AUTH_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "fen");
  return path.join(dir, "auth.json");
}

/** Loopback, or a Tailscale peer: the tailnet is an authenticated overlay
 * (WireGuard, only the user's own devices), so trusting it for the codex
 * routes is equivalent to trusting localhost. Tailscale assigns from the
 * CGNAT range 100.64.0.0/10 (v4) and fd7a:115c:a1e0::/48 (v6). Plain LAN
 * peers remain rejected. */
function trustedClient(req: Connect.IncomingMessage): boolean {
  let addr = req.socket.remoteAddress ?? "";
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  if (addr === "127.0.0.1" || addr === "::1") return true;
  const octets = addr.split(".").map(Number);
  if (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
    return true;
  }
  return addr.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

/**
 * Dev-only bridge that serves the local fen CLI's Codex OAuth credentials
 * (~/.config/fen/auth.json) to the page, which seeds them into the VM's
 * kv-backed auth path (browserBoot.ts). Dev server only — never part of a
 * build — and loopback-only, because `server.host: true` exposes the dev
 * server on the LAN and these are live ChatGPT OAuth tokens.
 */
function fenCodexAuthPlugin(): Plugin {
  return {
    name: "fen-codex-auth",
    configureServer(server) {
      // Plugin middlewares run before Vite's internal proxy middleware, so
      // this also gates /__codex-proxy: without it the proxy would be an
      // open LAN relay to chatgpt.com (harmless without a token, but tight
      // beats harmless).
      server.middlewares.use((req: Connect.IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__fen/") && !url.startsWith("/__codex-proxy")) {
          next();
          return;
        }
        // server.host true exposes the dev server on the LAN, and these
        // routes carry live ChatGPT OAuth material: loopback and tailnet
        // clients only.
        if (!trustedClient(req)) {
          res.statusCode = 403;
          res.end("codex routes are served to loopback/tailnet clients only");
          return;
        }
        // Same-origin only (defense-in-depth): a malicious page in the same
        // browser can hit localhost; SOP already blocks it reading the body,
        // but refuse cross-site fetches outright where the browser says so.
        const site = req.headers["sec-fetch-site"];
        if (typeof site === "string" && site !== "same-origin" && site !== "none") {
          res.statusCode = 403;
          res.end("codex routes are same-origin only");
          return;
        }
        if (!url.startsWith("/__fen/codex-auth")) {
          next(); // /__codex-proxy: fall through to Vite's proxy
          return;
        }
        try {
          // Serve only the openai-codex record — auth.json may hold other
          // providers' credentials the demo has no business copying.
          const all = JSON.parse(readFileSync(fenAuthPath(), "utf8")) as Record<string, unknown>;
          const codex = all["openai-codex"];
          if (!codex) throw new Error("no openai-codex record");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ "openai-codex": codex }));
        } catch {
          res.statusCode = 404;
          res.end("no codex creds in fen auth.json — run `fen --login openai-codex`");
        }
      });
    },
  };
}

// The demo bundles the fen submodule + fen-web Fennel trees as raw text via
// import.meta.glob (src/sources.ts), so the dev server must be allowed to
// read outside apps/demo. `@fen-web/runtime` also statically/dynamically
// references Node built-ins for its Node-only vendor readers, which the demo
// never runs; alias them to a throwing browser stub so Rollup can resolve
// them (see src/nodeBuiltinStub.ts).
export default defineConfig({
  root: here,
  plugins: [fenCodexAuthPlugin()],
  resolve: {
    alias: {
      "node:fs": nodeStub,
      "node:url": nodeStub,
      "node:path": nodeStub,
    },
  },
  server: {
    host: true,
    // Vite blocks non-localhost Host headers by default (DNS-rebinding
    // guard). Machine-specific hostnames for LAN access come from the
    // untracked environment (e.g. FEN_DEV_ALLOWED_HOSTS=wyse in
    // .envrc.local), comma-separated. The codex auth bridge stays
    // loopback-only regardless of Host.
    allowedHosts: (process.env.FEN_DEV_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    fs: { allow: [repoRoot] },
    // chatgpt.com/backend-api sends no CORS headers, so direct-from-page
    // Codex calls are impossible; in dev the provider's base-url is set to
    // /__codex-proxy (fen_web.demo.boot) and the dev server relays.
    proxy: {
      "/__codex-proxy": {
        target: "https://chatgpt.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__codex-proxy/, "/backend-api"),
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
