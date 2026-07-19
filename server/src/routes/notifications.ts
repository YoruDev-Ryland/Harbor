import type { FastifyInstance } from "fastify";
import { db, getSetting } from "../db.js";
import { requireAnyPerm, requirePerm, requireUser } from "../auth/auth.js";
import { getSmtp, saveSmtp, testSmtp, type SmtpConfig } from "../lib/mailer.js";
import { getUserPush, saveUserPush, testUserPush, type PushConfig } from "../lib/push.js";
import { validEmail } from "../auth/validation.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import { hasOnlyKeys } from "../auth/validation.js";
import { isIP } from "node:net";

function cleanLine(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !/[\r\n]/.test(value);
}

function validWebUrl(value: unknown): boolean {
  return normalizeHttpUrl(value) !== null;
}

function validSmtpHost(value: unknown): boolean {
  if (!cleanLine(value, 253) || !value.trim()) return false;
  const host = value.trim().replace(/^\[|\]$/g, "");
  return !!isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host);
}

const requireNotificationConfig = requireAnyPerm("manageNotifications", "manageSecrets");

export function notificationRoutes(app: FastifyInstance): void {
  // This user's feed + their unread count (read state is per row, per user).
  app.get("/api/notifications", { preHandler: requireUser }, async (req) => {
    const items = db
      .prepare(
        "SELECT id, kind, title, body, category, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50"
      )
      .all(req.user!.id);
    const unread = (
      db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
        .get(req.user!.id) as { n: number }
    ).n;
    return { items, unread };
  });

  app.post("/api/notifications/seen", { preHandler: requireUser }, async (req) => {
    db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"
    ).run(req.user!.id);
    return { ok: true };
  });

  // Clear this user's feed only.
  app.delete("/api/notifications", { preHandler: requireUser }, async (req) => {
    db.prepare("DELETE FROM notifications WHERE user_id = ?").run(req.user!.id);
    return { ok: true };
  });

  // ── SMTP settings (admin) ─────────────────────────────────────────
  app.get("/api/notifications/smtp", { preHandler: requireNotificationConfig }, async () => {
    const c = getSmtp();
    return {
      enabled: c.enabled,
      host: c.host,
      port: c.port,
      secure: c.secure,
      allowInsecureTls: c.allowInsecureTls,
      user: c.user,
      from: c.from,
      hasPass: !!c.pass, // never return the stored password
      customCa: !!process.env.HARBOR_SMTP_CA_FILE,
    };
  });

  app.patch<{ Body: Partial<SmtpConfig> & { pass?: string } }>(
    "/api/notifications/smtp",
    { preHandler: requireNotificationConfig },
    async (req, reply) => {
      const b = req.body ?? {};
      if (
        !hasOnlyKeys(b, [
          "enabled",
          "host",
          "port",
          "secure",
          "allowInsecureTls",
          "user",
          "pass",
          "from",
        ])
      )
        return reply.code(400).send({ error: "invalid SMTP settings" });
      if (
        !req.user!.permissions.manageNotifications &&
        Object.keys(b).some((key) => key !== "pass")
      )
        return reply.code(403).send({ error: "notification management permission required" });
      if (
        (b.enabled !== undefined && typeof b.enabled !== "boolean") ||
        (b.secure !== undefined && typeof b.secure !== "boolean") ||
        (b.allowInsecureTls !== undefined && typeof b.allowInsecureTls !== "boolean") ||
        (b.host !== undefined && !validSmtpHost(b.host)) ||
        (b.port !== undefined && (!Number.isInteger(b.port) || b.port < 1 || b.port > 65_535)) ||
        (b.user !== undefined && !cleanLine(b.user, 254)) ||
        (b.from !== undefined && !cleanLine(b.from, 320)) ||
        (b.pass !== undefined && !cleanLine(b.pass, 1_024))
      )
        return reply.code(400).send({ error: "invalid SMTP settings" });
      if ((b.pass || b.allowInsecureTls !== undefined) && !req.user!.permissions.manageSecrets)
        return reply.code(403).send({ error: "service credential permission required" });
      const result = saveSmtp(b);
      req.log.info(
        {
          actorId: req.user!.id,
          credentialEntered: !!b.pass,
          credentialCleared: result.credentialCleared,
        },
        "SMTP configuration changed"
      );
      return { ok: true, ...result };
    }
  );

  app.post<{ Body: { to?: string } }>(
    "/api/notifications/smtp/test",
    { preHandler: requirePerm("manageNotifications") },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body ?? {}, ["to"]))
        return reply.code(400).send({ error: "invalid SMTP test request" });
      const requested = typeof req.body?.to === "string" ? req.body.to.trim() : "";
      const to = requested || req.user!.email || undefined;
      if (to && !validEmail(to, false)) return reply.code(400).send({ error: "invalid recipient" });
      try {
        await testSmtp(to, getSetting("title", "Harbor"));
        return { ok: true, sentTo: to ?? null };
      } catch (err: any) {
        return reply.code(502).send({ error: err?.message ?? "SMTP test failed" });
      }
    }
  );

  // ── Private per-user push / ntfy settings ─────────────────────────
  app.get("/api/notifications/push/me", { preHandler: requireUser }, async (req) => {
    const c = getUserPush(req.user!.id);
    return {
      enabled: c.enabled,
      url: c.url,
      topic: c.topic,
      hasToken: !!c.token, // never return the stored token
    };
  });

  app.patch<{ Body: Partial<PushConfig> }>(
    "/api/notifications/push/me",
    { preHandler: requireUser },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!hasOnlyKeys(b, ["enabled", "url", "topic", "token", "clearToken"]))
        return reply.code(400).send({ error: "invalid push settings" });
      if (
        (b.enabled !== undefined && typeof b.enabled !== "boolean") ||
        (b.url !== undefined && !validWebUrl(b.url)) ||
        (b.topic !== undefined &&
          (typeof b.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.topic))) ||
        (b.token !== undefined && !cleanLine(b.token, 2_048)) ||
        ((b as any).clearToken !== undefined && typeof (b as any).clearToken !== "boolean")
      )
        return reply.code(400).send({ error: "invalid push settings" });
      const result = saveUserPush(
        req.user!.id,
        b as Partial<PushConfig> & { clearToken?: boolean }
      );
      req.log.info(
        {
          actorId: req.user!.id,
          credentialEntered: !!b.token,
          credentialCleared: result.credentialCleared,
        },
        "private push configuration changed"
      );
      return { ok: true, ...result };
    }
  );

  app.post("/api/notifications/push/me/test", { preHandler: requireUser }, async (req, reply) => {
    try {
      await testUserPush(req.user!.id, getSetting("title", "Harbor"));
      return { ok: true };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? "Push test failed" });
    }
  });
}
