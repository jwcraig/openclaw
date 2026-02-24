type OutlookReadonlyPluginConfig = {
  enabled: boolean;
  clientId: string;
  tenant: string;
  allowUpns: string[];
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

export function parseOutlookReadonlyConfig(value: unknown): OutlookReadonlyPluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const enabled = parseBoolean(raw.enabled, true);
  const clientId =
    parseString(raw.clientId) || parseString(process.env.OPENCLAW_OUTLOOK_CLIENT_ID) || "";
  const tenant =
    parseString(raw.tenant) || parseString(process.env.OPENCLAW_OUTLOOK_TENANT) || "common";

  return {
    enabled,
    clientId,
    tenant,
    allowUpns: parseStringArray(raw.allowUpns),
    allowCalendarWrite: parseBoolean(raw.allowCalendarWrite, false),
  };
}

export const outlookReadonlyConfigSchema = {
  parse(value: unknown): OutlookReadonlyPluginConfig {
    return parseOutlookReadonlyConfig(value);
  },
  uiHints: {
    enabled: { label: "Enabled" },
    clientId: {
      label: "Client ID",
      help: "Microsoft Entra app (public client) clientId for device code flow.",
    },
    tenant: {
      label: "Tenant",
      help: 'Tenant for auth: "common" (default), "organizations", "consumers", or a tenant id.',
      advanced: true,
    },
    allowUpns: {
      label: "Allowlist (UPNs)",
      help: "Optional allowlist of allowed accounts (userPrincipalName / email).",
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
      tenant: { type: "string", default: "common" },
      allowUpns: { type: "array", items: { type: "string" } },
      allowCalendarWrite: { type: "boolean", default: false },
    },
    required: [],
  },
};

export type { OutlookReadonlyPluginConfig };
