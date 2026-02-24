import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { GmailReadonlyPluginConfig } from "./gmail-readonly.config.js";
import { writeGoogleOAuth, type GoogleStoredOAuth } from "./gmail-readonly.credentials.js";
import { fetchGmailProfile } from "./gmail-readonly.gmail.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // Event-level calendar write (still no Gmail send).
  "https://www.googleapis.com/auth/calendar.events",
];

function redact(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function ensureLoopbackRedirect(redirectUri: string) {
  const url = new URL(redirectUri);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:") {
    throw new Error("redirectUri must be http:// (loopback only)");
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("redirectUri must be loopback (127.0.0.1 or localhost)");
  }
  const port = Number(url.port || "80");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("redirectUri must include a valid port");
  }
  return { url, port, path: url.pathname || "/" };
}

function encodeForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.set(k, v);
  }
  return body.toString();
}

async function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
      code: params.code,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };
}

export async function runGoogleOAuthLogin(api: OpenClawPluginApi, cfg: GmailReadonlyPluginConfig) {
  const { port, path } = ensureLoopbackRedirect(cfg.redirectUri);

  const state = crypto.randomBytes(16).toString("hex");
  const scope = DEFAULT_SCOPES.join(" ");

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  api.logger.info(`[gmail-readonly] Starting OAuth callback server on ${cfg.redirectUri}`);
  api.logger.info(`[gmail-readonly] Auth URL: ${authUrl.toString()}`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", cfg.redirectUri);
        if (url.pathname !== path) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Not Found");
          return;
        }
        const returnedState = url.searchParams.get("state") || "";
        const returnedCode = url.searchParams.get("code") || "";
        const returnedError = url.searchParams.get("error") || "";
        if (returnedError) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(`OAuth error: ${returnedError}`);
          reject(new Error(`OAuth error: ${returnedError}`));
          return;
        }
        if (!returnedCode) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Missing code");
          return;
        }
        if (returnedState !== state) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("State mismatch");
          reject(new Error("OAuth state mismatch"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("OpenClaw: OAuth complete. You can close this tab.");
        resolve(returnedCode);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setImmediate(() => server.close(() => undefined));
      }
    });

    server.on("error", (err) => reject(err));
    server.listen(port, "127.0.0.1");

    // Hard timeout to avoid hanging forever.
    setTimeout(
      () => {
        try {
          server.close(() => undefined);
        } catch {
          // ignore
        }
        reject(new Error("OAuth timed out (no callback received)"));
      },
      10 * 60 * 1000,
    ).unref();
  });

  api.logger.info(`[gmail-readonly] Got OAuth code (${redact(code)}). Exchanging for tokens…`);

  const token = await exchangeCodeForToken({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    code,
  });
  const now = Date.now();

  if (!token.refresh_token) {
    api.logger.warn(
      "[gmail-readonly] No refresh_token returned. If this is the first login, ensure prompt=consent and that you revoked prior consent.",
    );
  }

  const accessToken = token.access_token;
  const profile = await fetchGmailProfile(accessToken);
  const email = profile.emailAddress;

  if (cfg.allowEmails.length > 0 && !cfg.allowEmails.includes(email)) {
    throw new Error(
      `[gmail-readonly] Logged in as ${email}, but it is not in allowEmails. Refusing to store credentials.`,
    );
  }

  const stored: GoogleStoredOAuth = {
    provider: "google",
    email,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    accessToken,
    refreshToken: token.refresh_token || "",
    expiresAtMs: now + token.expires_in * 1000 - 30_000,
    scope: token.scope || scope,
    tokenType: token.token_type || "Bearer",
  };

  await writeGoogleOAuth(api, stored);
  api.logger.info(`[gmail-readonly] Stored credentials for ${email}.`);
  return { email };
}

export async function refreshGoogleAccessToken(params: {
  cfg: GmailReadonlyPluginConfig;
  refreshToken: string;
}) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm({
      client_id: params.cfg.clientId,
      client_secret: params.cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };
}
