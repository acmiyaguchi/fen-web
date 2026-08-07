import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerResponse } from "node:http";
import type { Connect } from "vite";
import {
  createConsoleMiddleware,
  FEN_CONSOLE_CLIENT_SNIPPET,
  trustedClient,
} from "./src/devConsole.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const nodeStub = path.resolve(here, "src", "nodeBuiltinStub.ts");
function buildFenVersion(): string {
  try {
    const version = readFileSync(path.join(repoRoot, "fen", "VERSION"), "utf8").trim();
    return version || "unknown";
  } catch {
    return "unknown";
  }
}

function buildWebVersion(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit || "dev";
  } catch {
    return "dev";
  }
}

/** fen's auth.json path, mirroring openai_codex_keychain.fnl's resolution
 * order: FEN_AUTH_DIR, then ${XDG_CONFIG_HOME:-~/.config}/fen. */
function fenAuthPath(): string {
  const dir =
    process.env.FEN_AUTH_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "fen");
  return path.join(dir, "auth.json");
}

/**
 * Dev-only host-console bridge. The serve-only transform runs before the
 * module script so it observes console calls before main.ts's diagnostics
 * wrapper, while the middleware keeps the terminal route loopback/tailnet
 * and same-origin guarded.
 */
function fenConsolePlugin(): Plugin {
  return {
    name: "fen-console-forward",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(createConsoleMiddleware());
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: "script",
              attrs: { type: "text/javascript" },
              children: FEN_CONSOLE_CLIENT_SNIPPET,
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

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
        const origin = req.headers.origin;
        if (origin === "null" || (typeof site === "string" && site !== "same-origin" && site !== "none")) {
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
// read outside apps/web. `@fen-web/runtime` also statically/dynamically
// references Node built-ins for its Node-only vendor readers, which the demo
// never runs; alias them to a throwing browser stub so Rollup can resolve
// them (see src/nodeBuiltinStub.ts).
export default defineConfig(({ mode }) => ({
  root: here,
  // GitHub Pages serves the app below /fen-web/, while the dev server stays
  // rooted at /. FEN_WEB_BASE is available for other deployment prefixes.
  base: process.env.FEN_WEB_BASE ?? (mode === "development" ? "/" : "/fen-web/"),
  plugins: [fenConsolePlugin(), fenCodexAuthPlugin()],
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
    // /__codex-proxy (fen_web.web.boot) and the dev server relays.
    proxy: {
      "/__codex-proxy": {
        target: "https://chatgpt.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__codex-proxy/, "/backend-api"),
      },
    },
  },
  define: {
    __FEN_VERSION: JSON.stringify(buildFenVersion()),
    __FEN_WEB_VERSION: JSON.stringify(buildWebVersion()),
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
}));
