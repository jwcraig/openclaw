type GmailReadonlyPluginConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowEmails: string[];
  allowCalendarWrite: boolean;
};

function parseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

export function parseGmailReadonlyConfig(value: unknown): GmailReadonlyPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const enabled = parseBoolean(raw.enabled, true);
  const clientId =
    parseString(raw.clientId) || parseString(process.env.OPENCLAW_GMAIL_CLIENT_ID) || "";
  const clientSecret =
    parseString(raw.clientSecret) || parseString(process.env.OPENCLAW_GMAIL_CLIENT_SECRET) || "";
  const redirectUri =
    parseString(raw.redirectUri) ||
    parseString(process.env.OPENCLAW_GMAIL_REDIRECT_URI) ||
    "http://127.0.0.1:42813/oauth2/callback";

  return {
    enabled,
    clientId,
    clientSecret,
    redirectUri,
    allowEmails: parseStringArray(raw.allowEmails),
    allowCalendarWrite: parseBoolean(raw.allowCalendarWrite, false),
  };
}

export const gmailReadonlyConfigSchema = {
  parse(value: unknown): GmailReadonlyPluginConfig {
    return parseGmailReadonlyConfig(value);
  },
  uiHints: {
    enabled: { label: "Enabled" },
    clientId: { label: "Client ID", help: "Google OAuth Client ID (Desktop app)." },
    clientSecret: {
      label: "Client Secret",
      help: "Google OAuth client secret (stored locally in your OpenClaw config).",
      advanced: true,
    },
    redirectUri: {
      label: "Redirect URI",
      help: "Loopback redirect URI registered in Google Cloud Console.",
      placeholder: "http://127.0.0.1:42813/oauth2/callback",
      advanced: true,
    },
    allowEmails: {
      label: "Allowlist (emails)",
      help: "Optional allowlist of Gmail addresses permitted for this integration.",
      advanced: true,
    },
    allowCalendarWrite: {
      label: "Allow Calendar Writes",
      help: "When enabled, allows creating calendar events (email stays read-only). Requires re-login for new OAuth scopes.",
      advanced: true,
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      clientId: { type: "string" },
      clientSecret: { type: "string" },
      redirectUri: { type: "string", default: "http://127.0.0.1:42813/oauth2/callback" },
      allowEmails: { type: "array", items: { type: "string" } },
      allowCalendarWrite: { type: "boolean", default: false },
    },
    required: [],
  },
};

export type { GmailReadonlyPluginConfig };
