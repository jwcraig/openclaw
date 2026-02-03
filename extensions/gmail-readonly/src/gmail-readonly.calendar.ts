const CAL_API_ROOT = "https://www.googleapis.com/calendar/v3";

export type CalendarEventSummary = {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string };
};

async function calFetch(accessToken: string, path: string, query?: Record<string, string>) {
  const url = new URL(`${CAL_API_ROOT}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`calendar api failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as any;
}

async function calFetchJson<T>(
  accessToken: string,
  path: string,
  body: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${CAL_API_ROOT}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`calendar api failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export async function listCalendarEvents(accessToken: string, params: {
  calendarId?: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
}) {
  const calendarId = params.calendarId?.trim() || "primary";
  const data = await calFetch(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      maxResults: String(params.maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    },
  );
  const items = Array.isArray(data.items) ? (data.items as any[]) : [];
  return items.map((e) => ({
    id: String(e.id || ""),
    status: typeof e.status === "string" ? e.status : undefined,
    htmlLink: typeof e.htmlLink === "string" ? e.htmlLink : undefined,
    summary: typeof e.summary === "string" ? e.summary : undefined,
    description: typeof e.description === "string" ? e.description : undefined,
    location: typeof e.location === "string" ? e.location : undefined,
    start: e.start,
    end: e.end,
    organizer: e.organizer,
  })) as CalendarEventSummary[];
}

export async function createCalendarEvent(
  accessToken: string,
  params: {
    calendarId?: string;
    summary: string;
    description?: string;
    location?: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
  },
): Promise<CalendarEventSummary> {
  const calendarId = params.calendarId?.trim() || "primary";
  const payload = {
    summary: params.summary,
    description: params.description,
    location: params.location,
    start: {
      dateTime: params.start.dateTime,
      ...(params.start.timeZone ? { timeZone: params.start.timeZone } : {}),
    },
    end: {
      dateTime: params.end.dateTime,
      ...(params.end.timeZone ? { timeZone: params.end.timeZone } : {}),
    },
  };
  const created = await calFetchJson<any>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    payload,
  );
  return {
    id: String(created.id || ""),
    status: typeof created.status === "string" ? created.status : undefined,
    htmlLink: typeof created.htmlLink === "string" ? created.htmlLink : undefined,
    summary: typeof created.summary === "string" ? created.summary : undefined,
    description: typeof created.description === "string" ? created.description : undefined,
    location: typeof created.location === "string" ? created.location : undefined,
    start: created.start,
    end: created.end,
    organizer: created.organizer,
  } as CalendarEventSummary;
}
