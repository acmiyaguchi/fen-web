# Spike: Codex OAuth from a static page

**Date:** 2026-08-07
**Code:** fen submodule `v0.17.0`, pinned at `07f114d7ebd7612fd8099720a4950db9f3b654d6`; network probes used no credentials.

## Finding

A static page can probably complete **credential acquisition**, but cannot use the resulting ChatGPT/Codex credential for inference directly. Codex inference is `chatgpt.com/backend-api/codex/*`, whose responses do not expose browser CORS headers. The minimal viable path for actual Codex use is therefore an MV3 extension/background fetch (#11), not a GitHub Pages-only change.

A static-only experiment is still possible: use fen's existing localhost redirect, retain PKCE state in the page, have the user paste the failed localhost callback URL back into the page, and POST the code to the currently CORS-enabled token endpoint. That yields tokens but still needs an extension or proxy for a Codex turn.

## 1. Fen's actual Codex provider

### Login and credential record

- `fen/extensions/adapters/providers/openai/openai_codex_login.fnl:21-24` hard-codes `https://auth.openai.com/oauth/authorize`, redirect `http://localhost:1455/auth/callback`, and scope `openid profile email offline_access`; the token URL is exported by `openai_codex_oauth.fnl`.
- `fen/extensions/adapters/providers/openai/openai_codex_login.fnl:71-98` generates a random 32-byte PKCE verifier and S256 challenge, then sends `response_type=code`, `state`, `codex_cli_simplified_flow=true`, `id_token_add_organizations=true`, and `originator=fen`. No `client_secret` is sent.
- `fen/extensions/adapters/providers/openai/openai_codex_oauth.fnl:21-24` contains public client id `app_EMoamEEZ73f0CkXaXp7hrann`. Current upstream Codex CLI exposes the same constant: [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs#L1617-L1625).
- `fen/extensions/adapters/providers/openai/openai_codex_login.fnl:157-205` POSTs form fields `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, and `client_id`. It requires `access_token`, `refresh_token`, and `expires_in`, then stores `{type:"oauth", access, refresh, expires: epoch_ms, accountId}`. `accountId` is extracted from the access JWT's `https://api.openai.com/auth` claim's `chatgpt_account_id` field (`fen/extensions/adapters/providers/openai/openai_codex_oauth.fnl:53-69`). The JWT is decoded without signature verification because fen trusts the file.
- `fen/extensions/adapters/providers/openai/openai_codex_login.fnl:123-150,226-240` accepts a full callback URL, query, `code#state`, or bare code. It checks state when supplied, but bare-code paste skips state validation; a browser UX should always require its own state.

### Refresh and storage

- `fen/extensions/adapters/providers/openai/openai_codex_oauth.fnl:99-133` refreshes at `/oauth/token` with `grant_type=refresh_token`, `refresh_token`, and the same public client id—again, no secret. `:140-191` refreshes when expiry is absent or within 60 seconds and persists the replacement pair.
- `fen/extensions/adapters/providers/openai/openai_codex_keychain.fnl:28-51,99-107` reads only `FEN_AUTH_DIR/auth.json`, then `${XDG_CONFIG_HOME:-~/.config}/fen/auth.json`. Despite a stale comment in `fen/extensions/adapters/providers/openai/openai_codex_responses.fnl:3-11`, v0.17.0's keychain has no pi-mono fallback.
- `fen/extensions/adapters/providers/openai/openai_codex_keychain.fnl:114-149` uses temp-file/rename and attempts `chmod 600`; a browser cannot reproduce that OS protection in localStorage or IndexedDB.

### Inference wire protocol

- `fen/extensions/adapters/providers/openai/openai_codex_responses.fnl:21-28` uses `https://chatgpt.com/backend-api/codex/responses` and `/codex/models?client_version=0.124.0`.
- `fen/extensions/adapters/providers/openai/openai_codex_responses.fnl:102-109` sends `Authorization: Bearer <access>`, `chatgpt-account-id`, `originator: pi`, `openai-beta: responses=experimental`, JSON, and an SSE accept header. Codex terminal event aliases are normalized at `:116-132`.
- The web boot registers this OAuth backend (`apps/web/fnl/fen_web/web/boot.fnl:249-269`) and sets base URL `/__codex-proxy` (`:283-294`) rather than calling ChatGPT directly. The Vite `configureServer` plugin reads only the `openai-codex` record from local `auth.json` and exposes it at `/__fen/codex-auth`, with loopback/tailnet and same-origin checks (`apps/web/vite.config.ts:38-91`); `browserBoot.ts:62-83` seeds that response into the VM's kv path. `apps/web/src/settings.ts:39-54` offers Codex only in dev builds, so the GitHub Pages build has neither the auth bridge nor proxy.

## 2. OAuth constraints and browser probes

### PKCE, client, and redirect

The live discovery document at [`https://auth.openai.com/.well-known/openid-configuration`](https://auth.openai.com/.well-known/openid-configuration), queried 2026-08-07, advertises authorization-code and refresh-token grants, S256, query responses, and `none` as an accepted token-endpoint auth method. It currently lists `/api/accounts/authorize` and `/api/accounts/oauth/token`, while fen v0.17.0 (and current Codex CLI source) use `/oauth/authorize` and `/oauth/token`. Treat these as private/unstable service routes, not a durable public web OAuth API; the metadata advertises no dynamic client-registration endpoint.

The existing client is registered for fen's localhost callback. Current Codex CLI source documents the same default port and a registered fallback port: [`login/src/server.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs#L59-L62,L176-L184). There is no evidence that `https://acmiyaguchi.github.io/fen-web/` (or a `chromiumapp.org` extension URL) is registered for this client. GitHub Pages is not inherently invalid as an OAuth redirect, but the page cannot register it itself; OpenAI would need to allowlist it or provide another client. Assume exact redirect matching.

The localhost registration does permit a manual static experiment: open the authorization URL in another tab, let the browser navigate to the non-listening callback, copy that URL, paste it into the original page, verify state, and exchange the code. This is credential acquisition only, not a working Codex client.

### CORS observations

Using `curl` with `Origin: https://acmiyaguchi.github.io` on 2026-08-07:

- `OPTIONS https://auth.openai.com/oauth/token` returned 200 with `Access-Control-Allow-Origin: *`, POST allowed, and `content-type` allowed. `/api/accounts/oauth/token` behaved similarly. A browser form POST is therefore currently plausible; it needs PKCE, not a secret.
- Preflights for `https://chatgpt.com/backend-api/codex/responses` and `/codex/models` returned 400 with no `Access-Control-Allow-Origin`. Unauthenticated direct probes also returned no allow-origin header. The real request's Authorization, account-id, and other headers require a preflight, so browser fetch cannot read or stream Codex output.
- This matches the implementation: `apps/web/vite.config.ts:128-136` rewrites `/__codex-proxy` to `https://chatgpt.com/backend-api`, and `apps/web/fnl/fen_web/web/boot.fnl:81-85,289-291` explicitly says the backend has no CORS headers.

The authorization page is a top-level navigation, so CORS is not the problem there; redirect registration and callback delivery are.

## 3. Ranked alternatives

1. **MV3 extension (#11): recommended for actual Codex.** Keep the refresh token in the background/service-worker side, perform Codex fetches with extension host permissions, and expose only requests/results through a narrow message protocol. This solves inference CORS and can later use `chrome.identity.launchWebAuthFlow` if an allowlisted redirect exists, or device-code/manual import otherwise. It is the smallest path consistent with the BYO-key/no-server-proxy goal.
2. **Device code: promising auth UX, not in fen v0.17.0.** Current public Codex CLI source implements `POST /api/accounts/deviceauth/usercode`, polling `/deviceauth/token`, verification at `/codex/device`, then a PKCE exchange: [`device_code_auth.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs#L62-L119,L165-L213). The endpoints currently answer CORS probes, but the CLI handles 404 as “device code login is not enabled.” No fen v0.17 source supports it, and it still does not grant browser access to ChatGPT inference. Confirm availability for this client/tenant before implementing.
3. **Paste/import `auth.json`: fastest compatibility fallback.** A static page can accept the CLI's `openai-codex` record (or pasted localhost callback) and store it locally. This avoids client registration and is useful with #11, but cannot make a Codex turn alone. Validate schema, never accept tokens in a URL, and provide clear/sign-out.
4. **Hosted token broker: technically works, not recommended.** It creates a central token and prompt/data trust boundary, plus abuse and availability obligations, and conflicts with the hard no-key-proxy non-goal (`README.md:57-62`). Do not introduce it silently as a “small” fix.

## 4. #11 versus static-only

### #11 should own

- `host.msg`/`host.ext` and an MV3 service-worker transport; these are planned but not implemented (`docs/architecture/fennel-first.md:30-40`).
- Extension-scoped token management and `chrome.storage`; never send raw refresh tokens to content scripts or the page. Serialize refreshes because rotation can race across worker restarts.
- Auth acquisition: extension redirect registration plus `launchWebAuthFlow`, device code, or import fallback. `docs/apps/extension.md:25-30` is only a sketch and incorrectly describes the current demo as device-flow polling.
- Model catalog and SSE completion through the worker. This is a privileged browser component, not a hosted fen proxy.

### Purely static page can

- Implement PKCE with manual localhost callback paste, or import the CLI record, because the token endpoint currently permits CORS.
- Store/display auth state and perhaps hand a credential to an installed extension through an explicitly designed integration.
- It **cannot** directly list Codex models or call/stream Codex completions from GitHub Pages under the observed CORS policy. Static-only support stops after authentication and is not a usable provider.

## 5. Security notes

- Access and refresh tokens are bearer credentials. Any same-origin script, XSS, compromised dependency, or malicious future bundle can read localStorage or IndexedDB; IndexedDB is storage, not a vault. Prefer memory/session storage for the PKCE verifier and access token, and never put tokens in query strings.
- Fen's CLI narrows disk exposure with `0600`; a static page cannot. Imported `auth.json` includes a replayable refresh token, so warn that import transfers trust to the page origin and provide clear/sign-out.
- An extension worker is a better boundary: keep access tokens in memory/session storage where practical, persist a refresh token only when required, and pass capabilities/results—not tokens—to content scripts. It still depends on extension update integrity, permissions, and correct MV3 lifecycle handling.

## Open questions

- Will OpenAI allowlist the fen-web GitHub Pages URL or an extension `chromiumapp.org` URL for a supported client id?
- Are `/oauth/*` and `/api/accounts/oauth/*` stable, documented third-party routes, and which should a future implementation use?
- Is device auth consistently enabled, and what are its CORS, expiry, cancellation, and rate-limit guarantees?
- Does OpenAI provide a supported browser/extension client, or must #11 reuse the public CLI client and localhost policy?
- How should refresh rotation, logout/revocation, multiple tabs, and MV3 restarts be coordinated without losing the only refresh token?
- Can `launchWebAuthFlow` use the existing client, or is device-code/manual-paste required after #11 lands?

## Summary

OAuth is PKCE-based, uses a public client id, and currently appears browser-postable at the token endpoint. The Codex inference backend is the blocking boundary: it is not CORS-readable from GitHub Pages. Implement #11's privileged extension transport and token custody; add device code only after availability is confirmed, with CLI `auth.json` import as fallback. A static page alone can acquire/import credentials, but cannot provide a working Codex backend without an extension or proxy.
