import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See README.md for Google OAuth setup.`);
  return v;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${body.error_description ?? body.error}`);
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

export async function calFetch<T = any>(urlPath: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const url = urlPath.startsWith("http") ? urlPath : `${CAL_BASE}${urlPath}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const bodyText = await res.text();
  let body: any = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }
  if (!res.ok) throw new Error(`Google Calendar API ${res.status}: ${body?.error?.message ?? bodyText.slice(0, 300)}`);
  return body as T;
}

function toIsoDate(value: string, allDay: boolean): string | { date: string } {
  if (allDay) return { date: value.slice(0, 10) };
  return new Date(value).toISOString();
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [sorted[0]];
  for (const iv of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push(iv);
  }
  return merged;
}

const server = new McpServer({ name: "scheduling-assistant-mcp", version: "1.0.0" });

server.registerTool(
  "list_calendars",
  {
    title: "List Calendars",
    description: "List the user's Google Calendars with IDs and access roles.",
    inputSchema: {},
  },
  async () => {
    try {
      const r = await calFetch<{ items?: any[] }>("/users/me/calendarList");
      const items = r.items ?? [];
      if (items.length === 0) return text("No calendars found.");
      return text(items.map((c) => `${c.id} — ${c.summary}${c.primary ? " (primary)" : ""} [${c.accessRole}]`).join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_events",
  {
    title: "List Events",
    description: "List calendar events in a time range.",
    inputSchema: {
      calendar_id: z.string().default("primary").describe("Calendar ID (default: primary)"),
      time_min: z.string().describe("Range start ISO datetime, e.g. 2026-08-24T00:00:00Z"),
      time_max: z.string().describe("Range end ISO datetime"),
      max_results: z.number().int().min(1).max(250).default(25),
    },
  },
  async ({ calendar_id, time_min, time_max, max_results }) => {
    try {
      const params = new URLSearchParams({
        timeMin: new Date(time_min).toISOString(),
        timeMax: new Date(time_max).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(max_results),
      });
      const r = await calFetch(`/calendars/${encodeURIComponent(calendar_id)}/events?${params}`);
      const events = r.items ?? [];
      if (events.length === 0) return text("No events in this range.");
      return text(
        events
          .map((ev: any) => {
            const start = ev.start?.dateTime ?? ev.start?.date;
            const end = ev.end?.dateTime ?? ev.end?.date;
            const attendees = (ev.attendees ?? []).map((a: any) => a.email).join(", ");
            return `[${ev.id}] ${start} → ${end}: ${ev.summary ?? "(no title)"}${attendees ? ` — attendees: ${attendees}` : ""}`;
          })
          .join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "create_event",
  {
    title: "Create Event",
    description: "Create a calendar event with optional guests, location and description.",
    inputSchema: {
      summary: z.string().min(1).describe("Event title"),
      start: z.string().describe("Start ISO datetime (or YYYY-MM-DD when all_day)"),
      end: z.string().describe("End ISO datetime (or YYYY-MM-DD when all_day)"),
      attendees: z.array(z.string().email()).optional().describe("Guest email addresses to invite"),
      description: z.string().optional(),
      location: z.string().optional(),
      calendar_id: z.string().default("primary"),
      all_day: z.boolean().default(false),
    },
  },
  async ({ summary, start, end, attendees, description, location, calendar_id, all_day }) => {
    try {
      const payload: Record<string, unknown> = {
        summary,
        start: toIsoDate(start, all_day),
        end: toIsoDate(end, all_day),
      };
      if (description) payload.description = description;
      if (location) payload.location = location;
      if (attendees && attendees.length > 0) {
        payload.attendees = attendees.map((email) => ({ email }));
        payload.sendUpdates = "all";
      }
      const ev = await calFetch(`/calendars/${encodeURIComponent(calendar_id)}/events`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const guestNote = attendees?.length ? ` Invites sent to ${attendees.join(", ")}.` : "";
      return text(`Created "${summary}" (${ev.start?.dateTime ?? ev.start?.date}). Event ID: ${ev.id}.${guestNote}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "delete_event",
  {
    title: "Delete Event",
    description: "Delete/cancel an event by ID.",
    inputSchema: {
      event_id: z.string(),
      calendar_id: z.string().default("primary"),
    },
  },
  async ({ event_id, calendar_id }) => {
    try {
      await calFetch(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`, { method: "DELETE" });
      return text(`Deleted event ${event_id}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_free_busy",
  {
    title: "Get Free/Busy",
    description: "Query busy intervals for one or more calendars in a time window.",
    inputSchema: {
      calendar_ids: z.array(z.string()).default(["primary"]),
      start: z.string().describe("Window start ISO datetime"),
      end: z.string().describe("Window end ISO datetime"),
    },
  },
  async ({ calendar_ids, start, end }) => {
    try {
      const r = await calFetch<any>("/freeBusy", {
        method: "POST",
        body: JSON.stringify({
          timeMin: new Date(start).toISOString(),
          timeMax: new Date(end).toISOString(),
          items: calendar_ids.map((id) => ({ id })),
        }),
      });
      const lines: string[] = [];
      for (const [calId, info] of Object.entries<any>(r.calendars ?? {})) {
        const busy = info.busy ?? [];
        lines.push(`${calId}: ${busy.length === 0 ? "completely free" : `${busy.length} busy block(s)`}`);
        for (const b of busy) lines.push(`  busy ${b.start} → ${b.end}`);
      }
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "find_available_slots",
  {
    title: "Find Available Slots",
    description:
      "Find free meeting slots of a given duration inside a search window, within configurable working hours.",
    inputSchema: {
      duration_minutes: z.number().int().min(15).max(720),
      start: z.string().describe("Search window start ISO datetime"),
      end: z.string().describe("Search window end ISO datetime"),
      calendar_ids: z.array(z.string()).default(["primary"]).describe("All calendars that must be free"),
      work_start_hour: z.number().int().min(0).max(23).default(9),
      work_end_hour: z.number().int().min(1).max(24).default(17),
      max_slots: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ duration_minutes, start, end, calendar_ids, work_start_hour, work_end_hour, max_slots }) => {
    try {
      const winStart = new Date(start);
      const winEnd = new Date(end);
      const r = await calFetch<any>("/freeBusy", {
        method: "POST",
        body: JSON.stringify({
          timeMin: winStart.toISOString(),
          timeMax: winEnd.toISOString(),
          items: calendar_ids.map((id) => ({ id })),
        }),
      });
      const busy: Interval[] = [];
      for (const info of Object.values<any>(r.calendars ?? {})) {
        for (const b of info.busy ?? []) busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
      }
      const mergedBusy = mergeIntervals(busy);
      const slots: string[] = [];
      let cursor = new Date(winStart);
      cursor.setMinutes(work_start_hour >= 0 ? 0 : 0);
      while (cursor < winEnd && slots.length < max_slots) {
        const dayStart = new Date(cursor);
        dayStart.setHours(work_start_hour, 0, 0, 0);
        const dayEnd = new Date(cursor);
        dayEnd.setHours(work_end_hour, 0, 0, 0);
        let slotStart = new Date(Math.max(cursor.getTime(), dayStart.getTime()));
        const slotLimit = new Date(Math.min(winEnd.getTime(), dayEnd.getTime()));
        while (slotStart < slotLimit && slots.length < max_slots) {
          const slotEnd = new Date(slotStart.getTime() + duration_minutes * 60_000);
          if (slotEnd > slotLimit) break;
          const conflict = mergedBusy.some((iv) => slotStart.getTime() < iv.end && slotEnd.getTime() > iv.start);
          if (!conflict) {
            slots.push(`${slotStart.toISOString()} → ${slotEnd.toISOString()}`);
            break;
          }
          const overlapping = mergedBusy.find((iv) => slotStart.getTime() < iv.end && slotEnd.getTime() > iv.start)!;
          slotStart = new Date(overlapping.end);
          slotStart.setSeconds(0, 0);
        }
        cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
        cursor.setHours(0, 0, 0, 0);
      }
      if (slots.length === 0)
        return text(`No free ${duration_minutes}-minute slots found between ${winStart.toISOString()} and ${winEnd.toISOString()} within working hours ${work_start_hour}:00–${work_end_hour}:00.`);
      return text(`First available ${duration_minutes}-minute slots:\n${slots.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error("[scheduling-assistant-mcp] connected over stdio");
