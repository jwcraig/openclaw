const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export type GraphMe = {
  id: string;
  displayName?: string;
  userPrincipalName?: string;
};

async function graphFetch(
  accessToken: string,
  path: string,
  query?: Record<string, string>,
  headers?: Record<string, string>,
) {
  const url = new URL(`${GRAPH_ROOT}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`graph api failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as any;
}

async function graphFetchJson<T>(
  accessToken: string,
  path: string,
  body: unknown,
  query?: Record<string, string>,
  headers?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${GRAPH_ROOT}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`graph api failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGraphMe(accessToken: string): Promise<GraphMe> {
  const data = await graphFetch(accessToken, "/me", {
    $select: "id,displayName,userPrincipalName",
  });
  const upn = String(data.userPrincipalName || "");
  if (!upn) {
    throw new Error("Graph /me missing userPrincipalName");
  }
  return data as GraphMe;
}

export async function listOutlookMessages(
  accessToken: string,
  params: { top: number; folder?: string },
) {
  const folder = params.folder?.trim() || "Inbox";
  const data = await graphFetch(
    accessToken,
    `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
    {
      $top: String(params.top),
      $select:
        "id,receivedDateTime,subject,from,toRecipients,ccRecipients,hasAttachments,bodyPreview,isRead,conversationId",
      $orderby: "receivedDateTime desc",
    },
  );
  const items = Array.isArray(data.value) ? (data.value as any[]) : [];
  return items;
}

export async function getOutlookMessage(
  accessToken: string,
  id: string,
  opts?: { bodyType?: "text" | "html" },
) {
  const bodyType = opts?.bodyType ?? "text";
  const data = await graphFetch(
    accessToken,
    `/me/messages/${encodeURIComponent(id)}`,
    {
      $select:
        "id,receivedDateTime,subject,from,toRecipients,ccRecipients,hasAttachments,bodyPreview,isRead,conversationId,body",
    },
    { Prefer: `outlook.body-content-type="${bodyType}"` },
  );
  return data;
}

export async function listOutlookCalendarView(
  accessToken: string,
  params: { startDateTime: string; endDateTime: string; top: number },
) {
  const data = await graphFetch(accessToken, "/me/calendarView", {
    startDateTime: params.startDateTime,
    endDateTime: params.endDateTime,
    $top: String(params.top),
    $select: "id,subject,bodyPreview,organizer,start,end,location,isAllDay,webLink",
    $orderby: "start/dateTime",
  });
  const items = Array.isArray(data.value) ? (data.value as any[]) : [];
  return items;
}

export async function createOutlookEvent(
  accessToken: string,
  params: {
    subject: string;
    body?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: string;
  },
) {
  const payload = {
    subject: params.subject,
    ...(params.body ? { body: { contentType: "text", content: params.body } } : {}),
    start: { dateTime: params.start.dateTime, timeZone: params.start.timeZone },
    end: { dateTime: params.end.dateTime, timeZone: params.end.timeZone },
    ...(params.location ? { location: { displayName: params.location } } : {}),
  };
  return graphFetchJson<any>(accessToken, "/me/events", payload);
}
