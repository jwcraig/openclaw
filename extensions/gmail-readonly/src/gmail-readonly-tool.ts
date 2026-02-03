import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import type { GmailReadonlyPluginConfig } from "./gmail-readonly.config.js";
import { createCalendarEvent, listCalendarEvents } from "./gmail-readonly.calendar.js";
import {
  getGmailMessage,
  listGmailMessages,
} from "./gmail-readonly.gmail.js";
import {
  listStoredGoogleAccounts,
  readGoogleOAuth,
  writeGoogleOAuth,
} from "./gmail-readonly.credentials.js";
import { refreshGoogleAccessToken } from "./gmail-readonly.google-oauth.js";

type ToolAction =
  | {
      action: "list_accounts";
    }
  | {
      action: "gmail_list_messages";
      account?: string;
      query?: string;
      maxResults?: number;
      includeDetails?: boolean;
    }
  | {
      action: "gmail_get_message";
      account?: string;
      id: string;
    }
  | {
      action: "calendar_list_events";
      account?: string;
      calendarId?: string;
      timeMin: string;
      timeMax: string;
      maxResults?: number;
    }
  | {
      action: "calendar_create_event";
      account?: string;
      calendarId?: string;
      summary: string;
      description?: string;
      location?: string;
      startDateTime: string;
      endDateTime: string;
      timeZone?: string;
    };

export const GmailReadonlyToolSchema = Type.Object(
  {
    action: stringEnum([
      "list_accounts",
      "gmail_list_messages",
      "gmail_get_message",
      "calendar_list_events",
      "calendar_create_event",
    ]),
    account: Type.Optional(
      Type.String({ description: "Gmail account email address (optional if only one is configured)" }),
    ),
    query: Type.Optional(Type.String({ description: "Gmail search query (q=...)" })),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
    includeDetails: Type.Optional(
      Type.Boolean({
        description:
          "When true, fetch message metadata (From/Subject/Date) for each listed message (default true).",
      }),
    ),
    id: Type.Optional(Type.String({ description: "Gmail message id" })),
    calendarId: Type.Optional(Type.String({ description: 'Calendar id (default "primary")' })),
    timeMin: Type.Optional(
      Type.String({ description: "RFC3339 start (inclusive), e.g. 2026-02-03T00:00:00Z" }),
    ),
    timeMax: Type.Optional(
      Type.String({ description: "RFC3339 end (exclusive), e.g. 2026-02-10T00:00:00Z" }),
    ),
    summary: Type.Optional(Type.String({ description: "Calendar event summary/title" })),
    description: Type.Optional(Type.String({ description: "Calendar event description (optional)" })),
    location: Type.Optional(Type.String({ description: "Calendar event location (optional)" })),
    startDateTime: Type.Optional(Type.String({ description: "RFC3339 start dateTime (inclusive)" })),
    endDateTime: Type.Optional(Type.String({ description: "RFC3339 end dateTime (exclusive)" })),
    timeZone: Type.Optional(
      Type.String({
        description:
          'IANA time zone (optional). Example: "America/Chicago". If omitted, calendar defaults apply.',
      }),
    ),
  },
  { additionalProperties: false },
);

function clampMaxResults(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

async function pickAccount(api: OpenClawPluginApi, requested: string | undefined) {
  const trimmed = (requested || "").trim();
  if (trimmed) return trimmed;
  const accounts = await listStoredGoogleAccounts(api);
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) {
    throw new Error("No Gmail accounts are configured. Run `openclaw gmail login` first.");
  }
  throw new Error(
    `Multiple Gmail accounts are configured (${accounts.join(", ")}). Pass account explicitly.`,
  );
}

async function getValidAccessToken(api: OpenClawPluginApi, cfg: GmailReadonlyPluginConfig, accountEmail: string) {
  const oauth = await readGoogleOAuth(api, accountEmail);
  const now = Date.now();
  if (oauth.expiresAtMs > now + 10_000) {
    return oauth.accessToken;
  }
  if (!oauth.refreshToken) {
    throw new Error("Stored credentials have no refresh token. Re-run `openclaw gmail login`.");
  }
  const refreshed = await refreshGoogleAccessToken({ cfg, refreshToken: oauth.refreshToken });
  const next = {
    ...oauth,
    accessToken: refreshed.access_token,
    expiresAtMs: now + refreshed.expires_in * 1000 - 30_000,
    tokenType: refreshed.token_type || oauth.tokenType,
    scope: refreshed.scope || oauth.scope,
    updatedAt: new Date(now).toISOString(),
  };
  await writeGoogleOAuth(api, next);
  return next.accessToken;
}

export function createGmailReadonlyTool(api: OpenClawPluginApi, cfg: GmailReadonlyPluginConfig) {
  function ensureConfigured() {
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error(
        "[gmail-readonly] Missing OAuth client config. Set " +
          'plugins.entries["gmail-readonly"].config.clientId and .clientSecret (or env OPENCLAW_GMAIL_CLIENT_ID / OPENCLAW_GMAIL_CLIENT_SECRET), then run `openclaw gmail login`.',
      );
    }
  }

  return {
    name: "gmail_readonly",
    label: "Gmail (Read-only)",
    description:
      "Read-only access to Gmail + Google Calendar for configured accounts. " +
      "Actions: list_accounts, gmail_list_messages, gmail_get_message, calendar_list_events.",
    parameters: GmailReadonlyToolSchema,
    async execute(_id: string, params: ToolAction) {
      if (params.action === "list_accounts") {
        const accounts = await listStoredGoogleAccounts(api);
        return {
          content: [{ type: "text", text: JSON.stringify({ accounts }, null, 2) }],
          details: { ok: true, action: params.action, accounts },
        };
      }

      ensureConfigured();

      const account = await pickAccount(api, "account" in params ? params.account : undefined);
      if (cfg.allowEmails.length > 0 && !cfg.allowEmails.includes(account)) {
        throw new Error(`[gmail-readonly] account ${account} is not in allowEmails`);
      }

      const accessToken = await getValidAccessToken(api, cfg, account);

      if (params.action === "gmail_get_message") {
        const id = (params.id || "").trim();
        if (!id) throw new Error("id is required");
        const msg = await getGmailMessage(accessToken, id, { format: "metadata" });
        return {
          content: [{ type: "text", text: JSON.stringify(msg, null, 2) }],
          details: { ok: true, action: params.action, account, id },
        };
      }

      if (params.action === "gmail_list_messages") {
        const maxResults = clampMaxResults(params.maxResults, 10);
        const includeDetails = typeof params.includeDetails === "boolean" ? params.includeDetails : true;
        const list = await listGmailMessages(accessToken, { q: params.query, maxResults });
        if (!includeDetails) {
          return {
            content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
            details: { ok: true, action: params.action, account, count: list.length },
          };
        }
        const detailed = [];
        for (const m of list) {
          detailed.push(await getGmailMessage(accessToken, m.id, { format: "metadata" }));
        }
        return {
          content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }],
          details: { ok: true, action: params.action, account, count: detailed.length },
        };
      }

      if (params.action === "calendar_list_events") {
        const timeMin = (params.timeMin || "").trim();
        const timeMax = (params.timeMax || "").trim();
        if (!timeMin) throw new Error("timeMin is required");
        if (!timeMax) throw new Error("timeMax is required");
        const maxResults = clampMaxResults(params.maxResults, 20);
        const events = await listCalendarEvents(accessToken, {
          calendarId: params.calendarId,
          timeMin,
          timeMax,
          maxResults,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
          details: { ok: true, action: params.action, account, count: events.length },
        };
      }

      if (params.action === "calendar_create_event") {
        if (!cfg.allowCalendarWrite) {
          throw new Error(
            '[gmail-readonly] Calendar writes are disabled. Set plugins.entries["gmail-readonly"].config.allowCalendarWrite=true and re-run `openclaw gmail login` to grant calendar write scope.',
          );
        }
        const summary = (params.summary || "").trim();
        const startDateTime = (params.startDateTime || "").trim();
        const endDateTime = (params.endDateTime || "").trim();
        if (!summary) throw new Error("summary is required");
        if (!startDateTime) throw new Error("startDateTime is required");
        if (!endDateTime) throw new Error("endDateTime is required");
        const created = await createCalendarEvent(accessToken, {
          calendarId: params.calendarId,
          summary,
          description: typeof params.description === "string" ? params.description : undefined,
          location: typeof params.location === "string" ? params.location : undefined,
          start: { dateTime: startDateTime, timeZone: params.timeZone },
          end: { dateTime: endDateTime, timeZone: params.timeZone },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(created, null, 2) }],
          details: { ok: true, action: params.action, account, id: created.id },
        };
      }

      throw new Error(`Unknown action: ${(params as any).action}`);
    },
  };
}
