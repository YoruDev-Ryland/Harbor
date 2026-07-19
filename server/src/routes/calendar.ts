import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getUserById } from "../auth/auth.js";
import { config } from "../config.js";
import { canSeeWidget, requireWidget } from "../lib/moduleAccess.js";
import { hashBearerToken } from "../lib/crypto.js";
import { gatherCalendar } from "./widgets.js";
import type { CalendarEvent } from "../modules/types.js";

/** RFC 5545 text escaping for SUMMARY/DESCRIPTION values. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}
function stamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function toVevent(ev: CalendarEvent, now: string): string {
  const summary = ev.episode ? `${ev.title} · ${ev.episode}` : ev.title;
  const desc = [ev.subtitle, ev.source.name, ev.state].filter(Boolean).join(" · ");
  const lines = ["BEGIN:VEVENT", `UID:${ev.id}@harbor`, `DTSTAMP:${now}`];
  if (ev.allDay) {
    const start = dateOnly(ev.airDateUtc);
    const end = dateOnly(new Date(new Date(ev.airDateUtc).getTime() + 86_400_000).toISOString());
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    const start = stamp(ev.airDateUtc);
    const end = stamp(new Date(new Date(ev.airDateUtc).getTime() + 3_600_000).toISOString());
    lines.push(`DTSTART:${start}`, `DTEND:${end}`);
  }
  lines.push(`SUMMARY:${esc(summary)}`);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

function buildIcs(events: CalendarEvent[]): string {
  const now = stamp(new Date().toISOString());
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Harbor//Release Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Harbor releases",
    ...events.map((ev) => toVevent(ev, now)),
    "END:VCALENDAR",
  ].join("\r\n");
}

function createToken(userId: number): string {
  const token = randomBytes(18).toString("base64url");
  db.prepare(
    "UPDATE users SET ical_token = NULL, ical_token_hash = ?, ical_token_last_used = NULL WHERE id = ?"
  ).run(hashBearerToken(token), userId);
  return token;
}

function feedUrl(token: string): string {
  const path = `/api/calendar.ics?token=${encodeURIComponent(token)}`;
  return config.publicUrl ? `${config.publicUrl}${path}` : path;
}

export function calendarRoutes(app: FastifyInstance): void {
  // Public but token-guarded — calendar apps can't carry a session cookie.
  app.get<{ Querystring: { token?: string } }>("/api/calendar.ics", async (req, reply) => {
    const token = req.query.token;
    if (typeof token !== "string" || token.length < 16 || token.length > 256)
      return reply.code(401).send("invalid or missing token");
    const matched = token
      ? (db
          .prepare("SELECT id FROM users WHERE ical_token_hash = ? AND disabled = 0")
          .get(hashBearerToken(token)) as { id: number } | undefined)
      : undefined;
    const user = matched ? getUserById(matched.id) : null;
    if (!user || !canSeeWidget(user, "calendar"))
      return reply.code(401).send("invalid or missing token");
    db.prepare("UPDATE users SET ical_token_last_used = datetime('now') WHERE id = ?").run(user.id);

    const start = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const { events } = await gatherCalendar(start, end, false, user);
    return reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Content-Disposition", 'inline; filename="harbor.ics"')
      .header("Cache-Control", "private, max-age=1800")
      .send(buildIcs(events));
  });

  // Bearer values are shown once, at creation/rotation, and only a digest is
  // retained. This status endpoint therefore cannot reveal an existing URL.
  app.get("/api/calendar/subscribe", { preHandler: requireWidget("calendar") }, async (req) => {
    const row = db
      .prepare("SELECT ical_token_hash, ical_token_last_used FROM users WHERE id = ?")
      .get(req.user!.id) as { ical_token_hash: string | null; ical_token_last_used: string | null };
    return { active: !!row.ical_token_hash, lastUsed: row.ical_token_last_used };
  });

  app.post(
    "/api/calendar/subscribe",
    { preHandler: requireWidget("calendar") },
    async (req, reply) => {
      const row = db
        .prepare("SELECT ical_token_hash FROM users WHERE id = ?")
        .get(req.user!.id) as {
        ical_token_hash: string | null;
      };
      if (row.ical_token_hash)
        return reply
          .code(409)
          .send({ error: "a subscription already exists; rotate it to reveal a new URL" });
      const token = createToken(req.user!.id);
      return { url: feedUrl(token), token };
    }
  );

  // Rotate the token — invalidates any calendar app still using the old URL.
  app.post("/api/calendar/rotate", { preHandler: requireWidget("calendar") }, async (req) => {
    const token = createToken(req.user!.id);
    return { url: feedUrl(token), token };
  });
}
