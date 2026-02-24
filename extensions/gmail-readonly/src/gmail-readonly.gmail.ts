const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1";

export type GmailProfile = {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
};

export type GmailMessageHeader = { name: string; value: string };

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  headers?: Record<string, string>;
};

function headerMap(headers: GmailMessageHeader[] | undefined) {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name?.trim();
    if (!name) continue;
    out[name.toLowerCase()] = h.value ?? "";
  }
  return out;
}

async function gmailFetch(
  accessToken: string,
  path: string,
  query?: Record<string, string | string[]>,
) {
  const url = new URL(`${GMAIL_API_ROOT}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (Array.isArray(v)) {
      for (const entry of v) {
        const trimmed = String(entry ?? "").trim();
        if (trimmed) {
          url.searchParams.append(k, trimmed);
        }
      }
      continue;
    }
    const trimmed = String(v ?? "").trim();
    if (trimmed) {
      url.searchParams.set(k, trimmed);
    }
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gmail api failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as any;
}

export async function fetchGmailProfile(accessToken: string): Promise<GmailProfile> {
  const data = await gmailFetch(accessToken, "/users/me/profile");
  const email = String(data.emailAddress || "");
  if (!email) {
    throw new Error("gmail profile missing emailAddress");
  }
  return data as GmailProfile;
}

export async function listGmailMessages(
  accessToken: string,
  params: {
    q?: string;
    maxResults: number;
  },
) {
  const data = await gmailFetch(accessToken, "/users/me/messages", {
    q: params.q || "",
    maxResults: String(params.maxResults),
  });
  const messages = Array.isArray(data.messages) ? (data.messages as any[]) : [];
  return messages
    .map((m) => ({ id: String(m.id || ""), threadId: String(m.threadId || "") }))
    .filter((m) => m.id);
}

export async function getGmailMessage(
  accessToken: string,
  id: string,
  opts?: { format?: "metadata" | "full" },
) {
  const format = opts?.format ?? "metadata";
  const data = await gmailFetch(accessToken, `/users/me/messages/${encodeURIComponent(id)}`, {
    format,
    // Gmail expects metadataHeaders as repeated query params (not a comma-separated string).
    metadataHeaders: ["From", "To", "Cc", "Bcc", "Subject", "Date"],
  });
  const payload = data.payload ?? {};
  const headers = headerMap(payload.headers as GmailMessageHeader[] | undefined);
  const out: GmailMessageSummary = {
    id: String(data.id || ""),
    threadId: String(data.threadId || ""),
    snippet: typeof data.snippet === "string" ? data.snippet : undefined,
    internalDate: typeof data.internalDate === "string" ? data.internalDate : undefined,
    labelIds: Array.isArray(data.labelIds) ? (data.labelIds as string[]) : undefined,
    headers,
  };
  return out;
}
