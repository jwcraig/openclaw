import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OutlookReadonlyPluginConfig } from "./outlook-readonly.config.js";
import { writeMicrosoftOAuth, type MicrosoftStoredOAuth } from "./outlook-readonly.credentials.js";
import { fetchGraphMe } from "./outlook-readonly.graph.js";

function encodeForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.set(k, v);
  }
  return body.toString();
}

function authBase(tenant: string) {
  const t = tenant.trim() || "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0`;
}

const DEFAULT_SCOPES = [
  "offline_access",
  "Mail.Read",
  // Calendar event creation/update/delete.
  "Calendars.ReadWrite",
  "User.Read",
];

export async function runMicrosoftDeviceCodeLogin(
  api: OpenClawPluginApi,
  cfg: OutlookReadonlyPluginConfig,
) {
  const scope = DEFAULT_SCOPES.join(" ");
  const base = authBase(cfg.tenant);
  const deviceCodeUrl = `${base}/devicecode`;
  const tokenUrl = `${base}/token`;

  const deviceRes = await fetch(deviceCodeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm({
      client_id: cfg.clientId,
      scope,
    }),
  });
  const deviceText = await deviceRes.text();
  if (!deviceRes.ok) {
    try {
      const parsed = JSON.parse(deviceText) as {
        error?: string;
        error_description?: string;
        error_codes?: number[];
      };
      const codes = Array.isArray(parsed.error_codes) ? parsed.error_codes : [];
      const description = String(parsed.error_description || "").trim();
      if (codes.includes(50059) || description.includes("AADSTS50059")) {
        throw new Error(
          "[outlook-readonly] Device code request failed (AADSTS50059). " +
            "This usually means Microsoft can't infer the tenant for your app. " +
            "If your app registration is single-tenant, set " +
            'plugins.entries["outlook-readonly"].config.tenant to your Directory (tenant) ID ' +
            "or tenant domain (e.g. contoso.onmicrosoft.com), then retry. " +
            `Current tenant setting: ${JSON.stringify(cfg.tenant)}.`,
        );
      }
      throw new Error(
        `device code failed (${deviceRes.status}): ${String(parsed.error || "error")} ${description}`.trim(),
      );
    } catch (err) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(`device code failed (${deviceRes.status}): ${deviceText.slice(0, 300)}`);
    }
  }
  const device = JSON.parse(deviceText) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
    message?: string;
  };

  api.logger.info("[outlook-readonly] Device code login started.");
  if (device.message) {
    api.logger.info(device.message);
  } else {
    api.logger.info(`[outlook-readonly] Visit: ${device.verification_uri}`);
    api.logger.info(`[outlook-readonly] Code: ${device.user_code}`);
  }
  if (device.verification_uri_complete) {
    api.logger.info(`[outlook-readonly] Direct link: ${device.verification_uri_complete}`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + device.expires_in * 1000;
  let intervalMs = Math.max(1, device.interval) * 1000;

  while (Date.now() < deadline) {
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: encodeForm({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: cfg.clientId,
        device_code: device.device_code,
      }),
    });
    const tokenText = await tokenRes.text();
    if (tokenRes.ok) {
      const token = JSON.parse(tokenText) as {
        token_type: string;
        scope: string;
        expires_in: number;
        access_token: string;
        refresh_token?: string;
      };
      const now = Date.now();
      const me = await fetchGraphMe(token.access_token);
      const upn = me.userPrincipalName!;

      if (cfg.allowUpns.length > 0 && !cfg.allowUpns.includes(upn)) {
        throw new Error(
          `[outlook-readonly] Logged in as ${upn}, but it is not in allowUpns. Refusing to store credentials.`,
        );
      }
      if (!token.refresh_token) {
        throw new Error(
          "[outlook-readonly] No refresh_token returned. Ensure offline_access scope is granted.",
        );
      }

      const stored: MicrosoftStoredOAuth = {
        provider: "microsoft",
        upn,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAtMs: now + token.expires_in * 1000 - 30_000,
        scope: token.scope || scope,
        tokenType: token.token_type || "Bearer",
        tenant: cfg.tenant,
      };
      await writeMicrosoftOAuth(api, stored);
      api.logger.info(`[outlook-readonly] Stored credentials for ${upn}.`);
      return { upn };
    }

    let err: { error?: string; error_description?: string };
    try {
      err = JSON.parse(tokenText) as any;
    } catch {
      throw new Error(`token polling failed (${tokenRes.status}): ${tokenText.slice(0, 300)}`);
    }
    const code = String(err.error || "");
    if (code === "authorization_pending") {
      // keep polling
    } else if (code === "slow_down") {
      intervalMs += 5_000;
    } else if (code === "expired_token") {
      throw new Error("device code expired; re-run login");
    } else if (code) {
      throw new Error(`device code login failed: ${code}`);
    } else {
      throw new Error(`token polling failed (${tokenRes.status})`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("device code login timed out");
}

export async function refreshMicrosoftAccessToken(params: {
  cfg: OutlookReadonlyPluginConfig;
  refreshToken: string;
}) {
  const base = authBase(params.cfg.tenant);
  const tokenUrl = `${base}/token`;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm({
      grant_type: "refresh_token",
      client_id: params.cfg.clientId,
      refresh_token: params.refreshToken,
      scope: DEFAULT_SCOPES.join(" "),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as {
    token_type: string;
    scope: string;
    expires_in: number;
    access_token: string;
    refresh_token?: string;
  };
}
