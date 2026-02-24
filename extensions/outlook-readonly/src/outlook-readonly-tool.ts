import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import type { OutlookReadonlyPluginConfig } from "./outlook-readonly.config.js";
import {
  listStoredMicrosoftAccounts,
  readMicrosoftOAuth,
  writeMicrosoftOAuth,
} from "./outlook-readonly.credentials.js";
import {
  createOutlookEvent,
  getOutlookMessage,
  listOutlookCalendarView,
  listOutlookMessages,
} from "./outlook-readonly.graph.js";
import { refreshMicrosoftAccessToken } from "./outlook-readonly.oauth.js";

type ToolAction =
  | { action: "list_accounts" }
  | {
      action: "mail_list_messages";
      account?: string;
      folder?: string;
      maxResults?: number;
    }
  | {
      action: "mail_get_message";
      account?: string;
      id: string;
      bodyType?: "text" | "html";
    }
  | {
      action: "calendar_list_events";
      account?: string;
      startDateTime: string;
      endDateTime: string;
      maxResults?: number;
    }
  | {
      action: "calendar_create_event";
      account?: string;
      subject: string;
      body?: string;
      startDateTime: string;
      endDateTime: string;
      timeZone?: string;
      location?: string;
    };

export const OutlookReadonlyToolSchema = Type.Object(
  {
    action: stringEnum([
      "list_accounts",
      "mail_list_messages",
      "mail_get_message",
      "calendar_list_events",
      "calendar_create_event",
    ]),
    account: Type.Optional(
      Type.String({
        description:
          "Microsoft account userPrincipalName/email (optional if only one is configured)",
      }),
    ),
    folder: Type.Optional(Type.String({ description: 'Mail folder name (default "Inbox")' })),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
    id: Type.Optional(Type.String({ description: "Message id" })),
    bodyType: Type.Optional(
      stringEnum(["text", "html"], { description: "Body type for message get" }),
    ),
    startDateTime: Type.Optional(Type.String({ description: "RFC3339 start (inclusive)" })),
    endDateTime: Type.Optional(Type.String({ description: "RFC3339 end (exclusive)" })),
    subject: Type.Optional(Type.String({ description: "Event subject/title" })),
    body: Type.Optional(Type.String({ description: "Event body/notes (plain text)" })),
    timeZone: Type.Optional(
      Type.String({
        description:
          'IANA time zone (optional). Example: "America/Chicago". If omitted, gateway time zone is used.',
      }),
    ),
    location: Type.Optional(Type.String({ description: "Event location (optional)" })),
  },
  { additionalProperties: false },
);

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function clampMaxResults(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

async function pickAccount(api: OpenClawPluginApi, requested: string | undefined) {
  const trimmed = (requested || "").trim();
  if (trimmed) return trimmed;
  const accounts = await listStoredMicrosoftAccounts(api);
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) {
    throw new Error("No Outlook accounts are configured. Run `openclaw outlook login` first.");
  }
  throw new Error(
    `Multiple Outlook accounts are configured (${accounts.join(", ")}). Pass account explicitly.`,
  );
}

async function getValidAccessToken(
  api: OpenClawPluginApi,
  cfg: OutlookReadonlyPluginConfig,
  upn: string,
) {
  const oauth = await readMicrosoftOAuth(api, upn);
  const now = Date.now();
  if (oauth.expiresAtMs > now + 10_000) {
    return oauth.accessToken;
  }
  if (!oauth.refreshToken) {
    throw new Error("Stored credentials have no refresh token. Re-run `openclaw outlook login`.");
  }
  const refreshed = await refreshMicrosoftAccessToken({ cfg, refreshToken: oauth.refreshToken });
  const next = {
    ...oauth,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || oauth.refreshToken,
    expiresAtMs: now + refreshed.expires_in * 1000 - 30_000,
    tokenType: refreshed.token_type || oauth.tokenType,
    scope: refreshed.scope || oauth.scope,
    updatedAt: new Date(now).toISOString(),
  };
  await writeMicrosoftOAuth(api, next);
  return next.accessToken;
}

export function createOutlookReadonlyTool(
  api: OpenClawPluginApi,
  cfg: OutlookReadonlyPluginConfig,
) {
  function ensureConfigured() {
    if (!cfg.clientId) {
      throw new Error(
        "[outlook-readonly] Missing OAuth client config. Set " +
          'plugins.entries["outlook-readonly"].config.clientId (or env OPENCLAW_OUTLOOK_CLIENT_ID), then run `openclaw outlook login`.',
      );
    }
  }

  function resolveDefaultTimeZone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
    } catch {
      return "UTC";
    }
  }

  return {
    name: "outlook_readonly",
    label: "Outlook (Read-only)",
    description:
      "Read-only access to Microsoft 365 mail + calendar via Microsoft Graph. " +
      "Actions: list_accounts, mail_list_messages, mail_get_message, calendar_list_events, calendar_create_event.",
    parameters: OutlookReadonlyToolSchema,
    async execute(_id: string, params: ToolAction) {
      if (params.action === "list_accounts") {
        const accounts = await listStoredMicrosoftAccounts(api);
        return textResult(JSON.stringify({ accounts }, null, 2), {
          ok: true,
          action: params.action,
          accounts,
        });
      }

      ensureConfigured();

      const account = await pickAccount(api, "account" in params ? params.account : undefined);
      if (cfg.allowUpns.length > 0 && !cfg.allowUpns.includes(account)) {
        throw new Error(`[outlook-readonly] account ${account} is not in allowUpns`);
      }

      const accessToken = await getValidAccessToken(api, cfg, account);

      if (params.action === "mail_list_messages") {
        const top = clampMaxResults(params.maxResults, 10);
        const items = await listOutlookMessages(accessToken, { top, folder: params.folder });
        return textResult(JSON.stringify(items, null, 2), {
          ok: true,
          action: params.action,
          account,
          count: items.length,
        });
      }

      if (params.action === "mail_get_message") {
        const id = (params.id || "").trim();
        if (!id) throw new Error("id is required");
        const msg = await getOutlookMessage(accessToken, id, { bodyType: params.bodyType });
        return textResult(JSON.stringify(msg, null, 2), {
          ok: true,
          action: params.action,
          account,
          id,
        });
      }

      if (params.action === "calendar_list_events") {
        const startDateTime = (params.startDateTime || "").trim();
        const endDateTime = (params.endDateTime || "").trim();
        if (!startDateTime) throw new Error("startDateTime is required");
        if (!endDateTime) throw new Error("endDateTime is required");
        const top = clampMaxResults(params.maxResults, 20);
        const items = await listOutlookCalendarView(accessToken, {
          startDateTime,
          endDateTime,
          top,
        });
        return textResult(JSON.stringify(items, null, 2), {
          ok: true,
          action: params.action,
          account,
          count: items.length,
        });
      }

      if (params.action === "calendar_create_event") {
        if (!cfg.allowCalendarWrite) {
          throw new Error(
            '[outlook-readonly] Calendar writes are disabled. Set plugins.entries["outlook-readonly"].config.allowCalendarWrite=true and re-run `openclaw outlook login` to grant calendar write scope.',
          );
        }
        const subject = (params.subject || "").trim();
        const startDateTime = (params.startDateTime || "").trim();
        const endDateTime = (params.endDateTime || "").trim();
        if (!subject) throw new Error("subject is required");
        if (!startDateTime) throw new Error("startDateTime is required");
        if (!endDateTime) throw new Error("endDateTime is required");

        const tz = (params.timeZone || "").trim() || resolveDefaultTimeZone();
        const created = await createOutlookEvent(accessToken, {
          subject,
          body: typeof params.body === "string" ? params.body : undefined,
          location: typeof params.location === "string" ? params.location : undefined,
          start: { dateTime: startDateTime, timeZone: tz },
          end: { dateTime: endDateTime, timeZone: tz },
        });
        return textResult(JSON.stringify(created, null, 2), {
          ok: true,
          action: params.action,
          account,
          id: String(created.id || ""),
        });
      }

      throw new Error(`Unknown action: ${(params as any).action}`);
    },
  };
}
