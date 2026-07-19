import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { db, getSetting, schemaVersion, userCount } from "../db.js";
import { hashPassword, hashRecoveryToken, verifyPassword } from "../lib/crypto.js";
import {
  clearSessionCookie,
  findUserByName,
  getUserById,
  requireUser,
  revokeSessions,
  setSessionCookie,
} from "./auth.js";
import { adminGroup, getGroup } from "./groups.js";
import { authRateLimit } from "./rateLimit.js";
import { consumeSetupToken, verifySetupToken } from "./setupToken.js";
import {
  hasOnlyKeys,
  isPlainRecord,
  validEmail,
  validPassword,
  validPhone,
  validUsername,
} from "./validation.js";

export function authRoutes(app: FastifyInstance): void {
  // Public: who am I + instance metadata the login/setup screens need.
  app.get("/api/auth/me", async (req) => {
    const sharedLayout = getSetting("widget_layout", "");
    // a user's own layout wins; '' means "follow the shared default"
    const personalLayout = req.user
      ? ((
          db.prepare("SELECT layout FROM users WHERE id = ?").get(req.user.id) as
            { layout: string } | undefined
        )?.layout ?? "")
      : "";
    return {
      user: req.user,
      sso: req.ssoLogin,
      needsSetup: userCount() === 0,
      title: getSetting("title", "Harbor"),
      defaultTheme: getSetting("default_theme", "dockyard"),
      layout: personalLayout || sharedLayout,
      defaultLayout: sharedLayout,
      hasCustomLayout: !!personalLayout,
      groupOrder: getSetting("group_order", ""),
      calendarActions: getSetting("calendar_actions", ""),
      authProxy: config.authProxy.enabled,
      version: config.appVersion,
      schemaVersion,
    };
  });

  // First-run: create the admin account. Only valid while no users exist.
  app.post<{ Body: { setupToken: string; username: string; password: string; email?: string } }>(
    "/api/auth/setup",
    { preHandler: authRateLimit({ name: "setup", limit: 10, windowMs: 15 * 60_000 }) },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body, ["setupToken", "username", "password", "email"]))
        return reply.code(400).send({ error: "invalid setup request" });
      if (userCount() > 0) return reply.code(409).send({ error: "already configured" });
      const { setupToken, username, password, email } = req.body ?? ({} as any);
      if (!verifySetupToken(setupToken)) {
        return reply.code(403).send({ error: "invalid setup token" });
      }
      const cleanUsername = typeof username === "string" ? username.trim() : "";
      const cleanEmail = typeof email === "string" ? email.trim() : "";
      if (!validUsername(cleanUsername) || !validPassword(password) || !validEmail(cleanEmail)) {
        return reply
          .code(400)
          .send({ error: "valid username, email, and password of 12-256 characters required" });
      }
      let newUserId: number;
      try {
        newUserId = db.transaction(() => {
          if (userCount() > 0) throw new Error("already-configured");
          const info = db
            .prepare(
              "INSERT INTO users (username, email, password_hash, role, group_id, last_login) VALUES (?, ?, ?, 'admin', ?, datetime('now'))"
            )
            .run(
              cleanUsername,
              cleanEmail || null,
              hashPassword(password),
              adminGroup()?.id ?? null
            );
          return Number(info.lastInsertRowid);
        })();
      } catch (error: any) {
        if (error?.message === "already-configured")
          return reply.code(409).send({ error: "already configured" });
        throw error;
      }
      const user = getUserById(newUserId)!;
      consumeSetupToken();
      setSessionCookie(reply, user.id);
      return { user };
    }
  );

  app.post<{ Body: { username: string; password: string } }>(
    "/api/auth/login",
    {
      preHandler: [
        authRateLimit({ name: "login-client", limit: 30, windowMs: 15 * 60_000 }),
        authRateLimit({
          name: "login-account",
          limit: 10,
          windowMs: 15 * 60_000,
          includeUsername: true,
        }),
      ],
    },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body, ["username", "password"]))
        return reply.code(400).send({ error: "invalid login request" });
      const { username, password } = req.body ?? ({} as any);
      const cleanUsername = typeof username === "string" ? username.trim() : "";
      const user = validUsername(cleanUsername) ? findUserByName(cleanUsername) : null;
      if (
        !user?.password_hash ||
        user.disabled ||
        typeof password !== "string" ||
        password.length > 256 ||
        !verifyPassword(password, user.password_hash)
      ) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
      setSessionCookie(reply, user.id);
      const { password_hash: _ph, ...safe } = user;
      return { user: safe };
    }
  );

  app.post<{ Body: { token?: string; password?: string } }>(
    "/api/auth/invite",
    { preHandler: authRateLimit({ name: "invite", limit: 10, windowMs: 15 * 60_000 }) },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body ?? {}, ["token", "password"]))
        return reply.code(400).send({ error: "invalid invitation" });
      const token = req.body?.token;
      const password = req.body?.password;
      if (
        typeof token !== "string" ||
        token.length < 32 ||
        token.length > 256 ||
        !validPassword(password)
      )
        return reply.code(400).send({ error: "invalid or expired invitation" });
      const digest = hashRecoveryToken(token);
      try {
        const userId = db.transaction(() => {
          const invite = db
            .prepare(
              `SELECT id, username, email, group_id FROM invitations
               WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
            )
            .get(digest, Date.now()) as
            { id: number; username: string; email: string | null; group_id: number } | undefined;
          if (!invite) throw new Error("invalid-invite");
          const group = getGroup(invite.group_id);
          if (!group) throw new Error("invalid-invite");
          const info = db
            .prepare(
              `INSERT INTO users (username, email, password_hash, role, group_id, last_login)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
            )
            .run(
              invite.username,
              invite.email,
              hashPassword(password),
              group.effective.admin ? "admin" : "user",
              invite.group_id
            );
          db.prepare("UPDATE invitations SET used_at = datetime('now') WHERE id = ?").run(
            invite.id
          );
          return Number(info.lastInsertRowid);
        })();
        setSessionCookie(reply, userId);
        return { ok: true, user: getUserById(userId) };
      } catch {
        return reply.code(400).send({ error: "invalid or expired invitation" });
      }
    }
  );

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) revokeSessions(req.user.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout-all", { preHandler: requireUser }, async (req, reply) => {
    revokeSessions(req.user!.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // Redeem an administrator-issued, short-lived token. The response is generic
  // so it does not reveal whether a token ever existed.
  app.post<{ Body: { token: string; password: string } }>(
    "/api/auth/reset",
    { preHandler: authRateLimit({ name: "reset", limit: 10, windowMs: 15 * 60_000 }) },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body, ["token", "password"]))
        return reply.code(400).send({ error: "invalid reset request" });
      const { token, password } = req.body ?? ({} as any);
      if (
        typeof token !== "string" ||
        token.length < 32 ||
        token.length > 256 ||
        !validPassword(password)
      ) {
        return reply.code(400).send({ error: "invalid or expired reset token" });
      }
      const digest = hashRecoveryToken(token);
      const apply = db.transaction(() => {
        const reset = db
          .prepare(
            "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"
          )
          .get(digest, Date.now()) as { id: number; user_id: number } | undefined;
        if (!reset) return null;
        const user = db.prepare("SELECT disabled FROM users WHERE id = ?").get(reset.user_id) as
          { disabled: number } | undefined;
        if (!user || user.disabled) return null;
        db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(
          reset.id
        );
        db.prepare(
          "UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?"
        ).run(hashPassword(password), reset.user_id);
        db.prepare(
          "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
        ).run(reset.user_id);
        return reset.user_id;
      });
      const userId = apply();
      if (!userId) return reply.code(400).send({ error: "invalid or expired reset token" });
      setSessionCookie(reply, userId);
      return { ok: true, user: getUserById(userId) };
    }
  );

  // Per-user preferences: theme and personal overview layout. Available to any
  // signed-in user — these only affect their own view, never other people's.
  app.patch<{ Body: { theme?: string; layout?: string } }>(
    "/api/auth/prefs",
    { preHandler: requireUser },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body, ["theme", "layout"]))
        return reply.code(400).send({ error: "invalid preferences" });
      const { theme, layout } = req.body ?? {};
      if (theme !== undefined && (typeof theme !== "string" || !/^[a-z0-9-]{1,32}$/.test(theme)))
        return reply.code(400).send({ error: "invalid theme" });
      if (theme) {
        db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, req.user!.id);
      }
      if (layout !== undefined) {
        if (typeof layout !== "string" || layout.length > 64_000)
          return reply.code(400).send({ error: "invalid layout" });
        // store '' to fall back to the shared default; otherwise require valid JSON array
        let value = "";
        if (layout) {
          try {
            const parsed = JSON.parse(layout);
            if (!Array.isArray(parsed) || parsed.length > 200)
              return reply.code(400).send({ error: "invalid layout" });
            value = layout;
          } catch {
            return reply.code(400).send({ error: "invalid layout" });
          }
        }
        db.prepare("UPDATE users SET layout = ? WHERE id = ?").run(value, req.user!.id);
      }
      return { user: getUserById(req.user!.id) };
    }
  );

  // Self-service contact details (for notifications).
  app.get("/api/auth/contact", { preHandler: requireUser }, async (req) => {
    return db
      .prepare(
        "SELECT email, phone, notify_email, notify_prefs, download_scope, request_email FROM users WHERE id = ?"
      )
      .get(req.user!.id);
  });

  app.patch<{
    Body: {
      email?: string;
      phone?: string;
      notify_email?: boolean;
      /** partial per-category overrides, merged into the stored prefs */
      notify_prefs?: Record<string, boolean>;
      /** 'all' | 'requested' — which finished downloads email this user */
      download_scope?: string;
      /** explicit request-manager email when it differs from the account email */
      request_email?: string;
    };
  }>("/api/auth/contact", { preHandler: requireUser }, async (req, reply) => {
    const b = req.body ?? {};
    if (
      !hasOnlyKeys(b, [
        "email",
        "phone",
        "notify_email",
        "notify_prefs",
        "download_scope",
        "request_email",
      ])
    )
      return reply.code(400).send({ error: "invalid contact details" });
    if (!validEmail(b.email) || !validPhone(b.phone) || !validEmail(b.request_email)) {
      return reply.code(400).send({ error: "invalid contact details" });
    }
    if (b.notify_email !== undefined && typeof b.notify_email !== "boolean")
      return reply.code(400).send({ error: "notify_email must be a boolean" });
    if (
      b.download_scope !== undefined &&
      b.download_scope !== "all" &&
      b.download_scope !== "requested"
    )
      return reply.code(400).send({ error: "invalid download scope" });
    if (b.notify_prefs !== undefined) {
      const allowed = ["downloads", "services", "disk", "websites", "general"];
      if (
        !isPlainRecord(b.notify_prefs) ||
        Object.entries(b.notify_prefs).some(
          ([key, value]) => !allowed.includes(key) || typeof value !== "boolean"
        )
      )
        return reply.code(400).send({ error: "invalid notification preferences" });
    }
    if (b.email !== undefined)
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(
        typeof b.email === "string" ? b.email.trim() || null : null,
        req.user!.id
      );
    if (b.phone !== undefined)
      db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(
        typeof b.phone === "string" ? b.phone.trim() || null : null,
        req.user!.id
      );
    if (b.download_scope === "all" || b.download_scope === "requested")
      db.prepare("UPDATE users SET download_scope = ? WHERE id = ?").run(
        b.download_scope,
        req.user!.id
      );
    if (b.request_email !== undefined)
      db.prepare("UPDATE users SET request_email = ? WHERE id = ?").run(
        typeof b.request_email === "string" ? b.request_email.trim() || null : null,
        req.user!.id
      );
    if (b.notify_email !== undefined)
      db.prepare("UPDATE users SET notify_email = ? WHERE id = ?").run(
        b.notify_email ? 1 : 0,
        req.user!.id
      );
    if (b.notify_prefs && typeof b.notify_prefs === "object" && !Array.isArray(b.notify_prefs)) {
      const row = db.prepare("SELECT notify_prefs FROM users WHERE id = ?").get(req.user!.id) as
        { notify_prefs: string | null } | undefined;
      let prefs: Record<string, boolean> = {};
      try {
        if (row?.notify_prefs) prefs = JSON.parse(row.notify_prefs);
      } catch {
        /* reset malformed prefs */
      }
      const allowed = new Set(["downloads", "services", "disk", "websites", "general"]);
      for (const [k, v] of Object.entries(b.notify_prefs)) {
        if (allowed.has(k) && typeof v === "boolean") prefs[k] = v;
      }
      db.prepare("UPDATE users SET notify_prefs = ? WHERE id = ?").run(
        JSON.stringify(prefs),
        req.user!.id
      );
    }
    return db
      .prepare(
        "SELECT email, phone, notify_email, notify_prefs, download_scope, request_email FROM users WHERE id = ?"
      )
      .get(req.user!.id);
  });

  // Change an existing local password. SSO-only accounts establish one through
  // the separately authorized one-time recovery flow.
  app.post<{ Body: { current?: string; password: string } }>(
    "/api/auth/password",
    {
      preHandler: [
        requireUser,
        authRateLimit({ name: "password-change", limit: 10, windowMs: 15 * 60_000 }),
      ],
    },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body, ["current", "password"]))
        return reply.code(400).send({ error: "invalid password request" });
      const { current, password } = req.body ?? ({} as any);
      if (!validPassword(password)) {
        return reply.code(400).send({ error: "password must be 12-256 characters" });
      }
      const me = findUserByName(req.user!.username)!;
      if (!me.password_hash) {
        return reply
          .code(403)
          .send({ error: "use a one-time reset link to establish a local password" });
      }
      if (me.password_hash && (!current || !verifyPassword(current, me.password_hash))) {
        return reply.code(403).send({ error: "current password incorrect" });
      }
      db.prepare(
        "UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?"
      ).run(hashPassword(password), req.user!.id);
      setSessionCookie(reply, req.user!.id);
      return { ok: true };
    }
  );
}
