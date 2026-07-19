import { db, getSetting } from "../db.js";
import { sendMail } from "./mailer.js";
import { sendUserPush } from "./push.js";
import { renderEmail, type EmailField } from "./emailTemplate.js";
import { canSeeCategoryRaw } from "./moduleAccess.js";

export type NotifyKind = "info" | "success" | "warn" | "error";

/** Event families users can individually opt in/out of for email delivery. */
export type NotifyCategory = "downloads" | "services" | "disk" | "websites" | "general";

export interface NotifyInput {
  kind?: NotifyKind;
  title: string;
  body?: string;
  /** which module family this event belongs to (drives per-user email opt-in) */
  category?: NotifyCategory;
  /** stable key used to debounce repeat events */
  eventKey?: string;
  /** suppress if an event with the same key fired within this window (ms) */
  dedupeMs?: number;
  /** structured detail rows — rendered as a table in the email */
  fields?: EmailField[];
  /** optional call-to-action button in the email */
  url?: string;
  urlLabel?: string;
  /** for downloads: emails of who requested this item, so users who only want
   *  their own requests can be matched (empty/absent = unattributed) */
  requesterEmails?: string[];
}

/** A user wants email for `category` when they've flipped it on, or when they've
 *  enabled the master switch and left this category unset. */
export function wantsEmail(
  category: NotifyCategory,
  notifyEmail: number | boolean,
  prefsJson: string | null
): boolean {
  let prefs: Record<string, boolean> = {};
  try {
    if (prefsJson) prefs = JSON.parse(prefsJson);
  } catch {
    /* malformed prefs fall back to the master switch */
  }
  if (category in prefs) return !!prefs[category];
  return !!notifyEmail;
}

const MAX_KEEP = 200;

interface Candidate {
  id: number;
  email: string | null;
  notify_email: number;
  notify_prefs: string | null;
  downloadScope: string | null;
  requestEmail: string | null;
  groupId: number | null;
  groupPermissions: string | null;
}

/**
 * The single entry point for every notification in Harbor. It computes *once*
 * which users an event is for — module visibility, plus the download "only my
 * requests" rule — then delivers it to each channel: an in-app feed row for
 * every eligible user, a private push to each configured user endpoint, and an
 * isolated email for those who opted in. There is no other path that creates
 * notifications.
 */
export async function notify(n: NotifyInput): Promise<void> {
  const category = n.category ?? "general";
  const kind = n.kind ?? "info";
  const requesters = new Set((n.requesterEmails ?? []).map((e) => e.trim().toLowerCase()));

  const candidates = db
    .prepare(
      `SELECT u.id, u.email, u.notify_email, u.notify_prefs, u.download_scope AS downloadScope,
              u.request_email AS requestEmail, u.group_id AS groupId,
              g.permissions AS groupPermissions
       FROM users u LEFT JOIN user_groups g ON g.id = u.group_id
       WHERE u.disabled = 0`
    )
    .all() as Candidate[];

  // ── one eligibility gate, shared by the feed and email ──────────────
  // A user is eligible if they can see the module the event belongs to, and —
  // for downloads when they only want their own — the grab was attributed to them.
  const eligible = candidates.filter((u) => {
    if (!canSeeCategoryRaw(u.groupId, u.groupPermissions, category)) return false;
    if (category === "downloads" && u.downloadScope === "requested") {
      const mine = (u.requestEmail || u.email || "").trim().toLowerCase();
      return !!mine && requesters.has(mine);
    }
    return true;
  });
  if (eligible.length === 0) return;

  // ── channel 1: the per-user in-app feed (with per-user dedupe + trim) ─
  const dedupeSecs = n.eventKey && n.dedupeMs ? Math.max(1, Math.round(n.dedupeMs / 1000)) : 0;
  const recentStmt = dedupeSecs
    ? db.prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND event_key = ? AND created_at > datetime('now', ?) LIMIT 1`
      )
    : null;
  const insertStmt = db.prepare(
    "INSERT INTO notifications (user_id, kind, title, body, category, event_key) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const trimStmt = db.prepare(
    `DELETE FROM notifications WHERE user_id = ?
       AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
  );

  const delivered = new Set<number>();
  db.transaction(() => {
    for (const u of eligible) {
      if (recentStmt && recentStmt.get(u.id, n.eventKey, `-${dedupeSecs} seconds`)) continue;
      insertStmt.run(u.id, kind, n.title, n.body ?? "", category, n.eventKey ?? null);
      trimStmt.run(u.id, u.id, MAX_KEEP);
      delivered.add(u.id);
    }
  })();

  // ── channel 2: private per-user phone push. Delivery uses the same
  // visibility, requester-only, and dedupe result as the in-app feed. ─
  const pushResults = await Promise.allSettled(
    eligible
      .filter((user) => delivered.has(user.id))
      .map((user) =>
        sendUserPush(user.id, {
          kind,
          title: n.title,
          body: n.body,
          url: n.url,
          urlLabel: n.urlLabel,
        })
      )
  );
  if (pushResults.some((result) => result.status === "rejected"))
    console.warn("[notify] one or more private push deliveries failed");

  // ── channel 3: email — eligible, opted in, has an address, and actually
  // got the feed item this pass (so email honours the same per-user dedupe) ─
  const recipients = eligible
    .filter(
      (u) => delivered.has(u.id) && u.email && wantsEmail(category, u.notify_email, u.notify_prefs)
    )
    .map((u) => u.email as string);
  if (recipients.length === 0) return;

  const siteTitle = getSetting("title", "Harbor");
  const { html, text } = renderEmail({
    kind,
    title: n.title,
    body: n.body,
    fields: n.fields,
    url: n.url,
    urlLabel: n.urlLabel,
    siteTitle,
  });
  try {
    await sendMail(recipients, `[${siteTitle}] ${n.title}`, { text, html });
  } catch (err: any) {
    console.warn("[notify] email delivery failed:", err?.message ?? err);
  }
}
