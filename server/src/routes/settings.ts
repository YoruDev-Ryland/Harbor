import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db, getSetting, setSetting } from "../db.js";
import {
  requireAdmin,
  requireAnyPerm,
  requirePerm,
  requireUser,
  revokeSessions,
} from "../auth/auth.js";
import type { User } from "../auth/auth.js";
import { adminUserCount, defaultGroup, getGroup } from "../auth/groups.js";
import { hashPassword, hashRecoveryToken } from "../lib/crypto.js";
import {
  hasOnlyKeys,
  validEmail,
  validPassword,
  validPhone,
  validUsername,
} from "../auth/validation.js";
import { PERMISSION_KEYS, resolvePermissions } from "../auth/permissions.js";

// which permission each editable setting key demands
const SETTING_PERM = {
  title: "manageSettings",
  default_theme: "manageSettings",
  widget_layout: "editLayout",
  group_order: "manageBerths",
  // how a calendar event click resolves — a shared, important default, admin-only
  calendar_actions: "manageSettings",
  scope_reset_time: "manageSettings",
  scope_reset_timezone: "manageSettings",
} as const;

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.length <= 128;
  } catch {
    return false;
  }
}

const USER_SELECT = `
  SELECT u.id, u.username, u.email, u.phone, u.notify_email, u.role, u.created_at, u.last_login,
         u.password_hash IS NOT NULL AS has_password, u.disabled, u.group_id, g.name AS group_name,
         g.permissions AS group_permissions
  FROM users u LEFT JOIN user_groups g ON g.id = u.group_id`;

function publicUser(row: any, includeProfile: boolean, includeIdentities: boolean) {
  const shaped = { ...row, is_admin: resolvePermissions(row.group_permissions).admin ? 1 : 0 };
  delete shaped.group_permissions;
  shaped.identities = db
    .prepare(
      "SELECT id, provider, subject FROM auth_identities WHERE user_id = ? ORDER BY provider, subject"
    )
    .all(row.id);
  if (!includeIdentities) shaped.identities = [];
  if (!includeProfile) {
    shaped.email = null;
    shaped.phone = null;
    shaped.notify_email = 0;
  }
  return shaped;
}

function targetIsAdmin(row: { group_id: number | null }): boolean {
  return row.group_id != null && !!getGroup(row.group_id)?.effective.admin;
}

function canControlCredentials(actorIsAdmin: boolean, row: { group_id: number | null }): boolean {
  return actorIsAdmin || !targetIsAdmin(row);
}

function groupWithinActor(actor: User, groupId: number | null): boolean {
  if (actor.permissions.admin) return true;
  const group = groupId != null ? getGroup(groupId) : undefined;
  if (!group) return false;
  return PERMISSION_KEYS.every(
    (permission) => !group.effective[permission] || actor.permissions[permission]
  );
}

function canManageUserTarget(actor: User, row: { group_id: number | null }): boolean {
  return groupWithinActor(actor, row.group_id);
}

export function settingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings", { preHandler: requirePerm("manageSettings") }, async () => ({
    title: getSetting("title", "Harbor"),
    default_theme: getSetting("default_theme", "dockyard"),
    widget_layout: getSetting("widget_layout", ""),
    group_order: getSetting("group_order", ""),
    calendar_actions: getSetting("calendar_actions", ""),
    scope_reset_time: getSetting("scope_reset_time", "20:00"),
    scope_reset_timezone: getSetting(
      "scope_reset_timezone",
      process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    ),
  }));

  // Each key is gated independently so an "edit layout" user can save the layout
  // without also holding "manage appearance".
  app.patch<{ Body: Record<string, string> }>(
    "/api/settings",
    { preHandler: requireUser },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body ?? {}, Object.keys(SETTING_PERM)))
        return reply.code(400).send({ error: "invalid settings" });
      const changes: Array<[string, string]> = [];
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (!(key in SETTING_PERM) || typeof value !== "string") continue;
        const perm = SETTING_PERM[key as keyof typeof SETTING_PERM];
        if (!req.user!.permissions[perm]) return reply.code(403).send({ error: "forbidden" });
        const max = key === "title" || key === "default_theme" ? 128 : 64_000;
        if (value.length > max) return reply.code(400).send({ error: `${key} is too large` });
        if (key === "scope_reset_time" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
          return reply.code(400).send({ error: "invalid telescope reset time" });
        if (key === "scope_reset_timezone" && !validTimeZone(value))
          return reply.code(400).send({ error: "invalid telescope reset time zone" });
        changes.push([key, value]);
      }
      db.transaction(() => {
        for (const [key, value] of changes) setSetting(key, value);
      })();
      return { ok: true };
    }
  );

  // ── crew (users) ─────────────────────────────────────────────────
  app.get(
    "/api/users",
    { preHandler: requireAnyPerm("manageUsers", "manageCredentials") },
    async (req) =>
      (db.prepare(`${USER_SELECT} ORDER BY u.username`).all() as any[]).map((row) =>
        publicUser(row, req.user!.permissions.manageUsers, req.user!.permissions.admin)
      )
  );

  app.post<{ Body: { username: string; password?: string; email?: string; group_id?: number } }>(
    "/api/users",
    { preHandler: requirePerm("manageUsers") },
    async (req, reply) => {
      const b = req.body ?? ({} as any);
      if (!hasOnlyKeys(b, ["username", "password", "email", "group_id"]))
        return reply.code(400).send({ error: "invalid user settings" });
      const username = typeof b.username === "string" ? b.username.trim() : "";
      const email = typeof b.email === "string" ? b.email.trim() : "";
      if (!validUsername(username))
        return reply.code(400).send({ error: "valid username required" });
      if (!validEmail(email)) return reply.code(400).send({ error: "valid email required" });
      if (b.password && !req.user!.permissions.manageCredentials)
        return reply.code(403).send({ error: "credential management permission required" });
      if (b.password && !validPassword(b.password))
        return reply.code(400).send({ error: "password must be 12-256 characters" });

      if (b.group_id != null && (!Number.isInteger(b.group_id) || b.group_id < 1))
        return reply.code(400).send({ error: "unknown group" });
      const group = b.group_id != null ? getGroup(b.group_id) : defaultGroup();
      if (!group) return reply.code(400).send({ error: "unknown group" });
      // Only a Harbormaster may mint another Harbormaster.
      if (group.effective.admin && !req.user!.permissions.admin)
        return reply.code(403).send({ error: "only an admin can assign an admin group" });
      if (!groupWithinActor(req.user!, group.id))
        return reply.code(403).send({ error: "cannot assign permissions you do not hold" });

      try {
        const info = db
          .prepare(
            "INSERT INTO users (username, email, password_hash, role, group_id) VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            username,
            email || null,
            b.password ? hashPassword(b.password) : null,
            group.effective.admin ? "admin" : "user",
            group.id
          );
        return publicUser(
          db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(info.lastInsertRowid),
          true,
          req.user!.permissions.admin
        );
      } catch {
        return reply.code(409).send({ error: "username already exists" });
      }
    }
  );

  app.get("/api/users/invites", { preHandler: requirePerm("manageUsers") }, async () =>
    db
      .prepare(
        `SELECT i.id, i.username, i.email, i.group_id, g.name AS group_name,
                i.expires_at, i.created_at
         FROM invitations i JOIN user_groups g ON g.id = i.group_id
         WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.id DESC LIMIT 200`
      )
      .all(Date.now())
  );

  app.post<{
    Body: { username?: string; email?: string; group_id?: number; expires_days?: number };
  }>("/api/users/invites", { preHandler: requirePerm("manageUsers") }, async (req, reply) => {
    const body = req.body ?? {};
    if (!hasOnlyKeys(body, ["username", "email", "group_id", "expires_days"]))
      return reply.code(400).send({ error: "invalid invitation" });
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const expiresDays = body.expires_days ?? 7;
    if (!validUsername(username) || !validEmail(email))
      return reply.code(400).send({ error: "valid username and email required" });
    if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 30)
      return reply.code(400).send({ error: "invitation expiry must be 1-30 days" });
    const group = body.group_id != null ? getGroup(body.group_id) : defaultGroup();
    if (!group) return reply.code(400).send({ error: "unknown group" });
    if (group.effective.admin && !req.user!.permissions.admin)
      return reply.code(403).send({ error: "only an admin can invite an admin" });
    if (!groupWithinActor(req.user!, group.id))
      return reply.code(403).send({ error: "cannot assign permissions you do not hold" });
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username))
      return reply.code(409).send({ error: "username already exists" });
    if (
      db
        .prepare(
          "SELECT 1 FROM invitations WHERE username = ? AND used_at IS NULL AND expires_at > ?"
        )
        .get(username, Date.now())
    )
      return reply.code(409).send({ error: "an active invitation already exists" });

    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + expiresDays * 86_400_000;
    const info = db.transaction(() => {
      db.prepare(
        "DELETE FROM invitations WHERE (used_at IS NOT NULL OR expires_at < ?) AND created_at < datetime('now', '-7 days')"
      ).run(Date.now());
      return db
        .prepare(
          `INSERT INTO invitations
             (token_hash, username, email, group_id, expires_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(hashRecoveryToken(token), username, email || null, group.id, expiresAt, req.user!.id);
    })();
    const invitePath = `/accept-invite?token=${encodeURIComponent(token)}`;
    return {
      id: Number(info.lastInsertRowid),
      token,
      invitePath,
      inviteUrl: config.publicUrl ? `${config.publicUrl}${invitePath}` : null,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/users/invites/:id",
    { preHandler: requirePerm("manageUsers") },
    async (req, reply) => {
      const result = db
        .prepare("DELETE FROM invitations WHERE id = ? AND used_at IS NULL")
        .run(req.params.id);
      if (result.changes === 0) return reply.code(404).send({ error: "not found" });
      return { ok: true };
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      group_id?: number;
      /** Direct manager-set passwords are rejected; use the one-time reset flow. */
      password?: string;
      email?: string;
      phone?: string;
      notify_email?: boolean;
      disabled?: boolean;
    };
  }>("/api/users/:id", { preHandler: requirePerm("manageUsers") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    const b = req.body ?? {};
    if (!hasOnlyKeys(b, ["group_id", "password", "email", "phone", "notify_email", "disabled"]))
      return reply.code(400).send({ error: "invalid user settings" });
    const actorIsAdmin = req.user!.permissions.admin;
    if (!canManageUserTarget(req.user!, row))
      return reply.code(403).send({ error: "cannot modify a more-privileged account" });
    if (b.password !== undefined)
      return reply.code(400).send({ error: "use the one-time password reset endpoint" });
    if (!validEmail(b.email) || !validPhone(b.phone))
      return reply.code(400).send({ error: "invalid contact details" });
    if (b.notify_email !== undefined && typeof b.notify_email !== "boolean")
      return reply.code(400).send({ error: "notify_email must be a boolean" });
    if (b.disabled !== undefined && typeof b.disabled !== "boolean")
      return reply.code(400).send({ error: "disabled must be a boolean" });

    let nextGroup: ReturnType<typeof getGroup> = undefined;
    if (b.group_id != null) {
      if (!Number.isInteger(b.group_id) || b.group_id < 1)
        return reply.code(400).send({ error: "unknown group" });
      nextGroup = getGroup(b.group_id);
      if (!nextGroup) return reply.code(400).send({ error: "unknown group" });
      if (nextGroup.effective.admin && !actorIsAdmin)
        return reply.code(403).send({ error: "only an admin can assign an admin group" });
      if (!groupWithinActor(req.user!, nextGroup.id))
        return reply.code(403).send({ error: "cannot assign permissions you do not hold" });
    }
    if (b.disabled !== undefined && !!b.disabled !== !!row.disabled && row.id === req.user!.id)
      return reply.code(400).send({ error: "cannot disable your own account" });

    try {
      db.transaction(() => {
        if (b.email !== undefined)
          db.prepare("UPDATE users SET email = ? WHERE id = ?").run(
            typeof b.email === "string" ? b.email.trim() || null : null,
            row.id
          );
        if (b.phone !== undefined)
          db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(
            typeof b.phone === "string" ? b.phone.trim() || null : null,
            row.id
          );
        if (b.notify_email !== undefined)
          db.prepare("UPDATE users SET notify_email = ? WHERE id = ?").run(
            b.notify_email ? 1 : 0,
            row.id
          );
        if (nextGroup) {
          db.prepare("UPDATE users SET group_id = ?, role = ? WHERE id = ?").run(
            nextGroup.id,
            nextGroup.effective.admin ? "admin" : "user",
            row.id
          );
        }
        if (b.disabled !== undefined && !!b.disabled !== !!row.disabled) {
          db.prepare(
            "UPDATE users SET disabled = ?, session_version = session_version + 1 WHERE id = ?"
          ).run(b.disabled ? 1 : 0, row.id);
        }
        if (adminUserCount() === 0) throw new Error("last-admin");
      })();
    } catch (error: any) {
      if (error?.message === "last-admin")
        return reply.code(400).send({ error: "cannot remove or disable the last Harbormaster" });
      throw error;
    }
    return publicUser(
      db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(row.id),
      true,
      req.user!.permissions.admin
    );
  });

  app.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    { preHandler: requirePerm("manageUsers") },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as any;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.id === req.user!.id) return reply.code(400).send({ error: "cannot delete yourself" });
      if (!canManageUserTarget(req.user!, row))
        return reply.code(403).send({ error: "cannot delete a more-privileged account" });
      try {
        const apply = db.transaction(() => {
          // Preserve the fact that an action happened without retaining a
          // deleted member's username or network address indefinitely.
          db.prepare(
            "UPDATE audit_log SET actor_username = 'deleted-user', remote_address = NULL WHERE actor_user_id = ?"
          ).run(row.id);
          db.prepare("DELETE FROM invitations WHERE username = ? COLLATE NOCASE").run(row.username);
          db.prepare("DELETE FROM users WHERE id = ?").run(row.id);
          if (adminUserCount() === 0) throw new Error("last-admin");
        });
        apply();
      } catch (err: any) {
        if (err?.message === "last-admin")
          return reply.code(400).send({ error: "cannot delete the last Harbormaster" });
        throw err;
      }
      return { ok: true };
    }
  );

  // Explicit binding is required for password-bearing local accounts. This is
  // admin-only because the subject must already be verified by the configured
  // identity provider outside Harbor.
  app.post<{ Params: { id: string }; Body: { provider?: string; subject?: string } }>(
    "/api/users/:id/identities",
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body ?? {}, ["provider", "subject"]))
        return reply.code(400).send({ error: "invalid identity" });
      const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id) as
        { id: number } | undefined;
      if (!user) return reply.code(404).send({ error: "not found" });
      const provider =
        typeof req.body?.provider === "string" ? req.body.provider.trim().toLowerCase() : "";
      const subject =
        typeof req.body?.subject === "string" ? req.body.subject.trim().toLowerCase() : "";
      if (
        !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(provider) ||
        !/^[a-z0-9][a-z0-9._@:+/-]{0,253}$/.test(subject)
      )
        return reply.code(400).send({ error: "invalid provider or stable subject" });
      try {
        const info = db
          .prepare(
            "INSERT INTO auth_identities (provider, subject, user_id, display) VALUES (?, ?, ?, ?)"
          )
          .run(provider, subject, user.id, subject);
        revokeSessions(user.id);
        return { id: Number(info.lastInsertRowid), provider, subject };
      } catch {
        return reply.code(409).send({ error: "provider or subject is already bound" });
      }
    }
  );

  app.delete<{ Params: { id: string; identityId: string } }>(
    "/api/users/:id/identities/:identityId",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const result = db
        .prepare("DELETE FROM auth_identities WHERE id = ? AND user_id = ?")
        .run(req.params.identityId, req.params.id);
      if (result.changes === 0) return reply.code(404).send({ error: "not found" });
      revokeSessions(Number(req.params.id));
      return { ok: true };
    }
  );

  // Credential managers never choose or learn a user's new password. They can
  // only issue a short-lived, single-use token and must deliver it out-of-band.
  app.post<{ Params: { id: string } }>(
    "/api/users/:id/password-reset",
    { preHandler: requirePerm("manageCredentials") },
    async (req, reply) => {
      const row = db
        .prepare("SELECT id, group_id, disabled FROM users WHERE id = ?")
        .get(req.params.id) as
        { id: number; group_id: number | null; disabled: number } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (!canControlCredentials(req.user!.permissions.admin, row))
        return reply.code(403).send({ error: "only an admin can reset an admin account" });
      if (row.disabled)
        return reply.code(409).send({ error: "enable the account before resetting it" });

      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 15 * 60_000;
      db.transaction(() => {
        db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(
          Date.now() - 7 * 86_400_000
        );
        db.prepare(
          "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
        ).run(row.id);
        db.prepare(
          "INSERT INTO password_resets (user_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?)"
        ).run(row.id, hashRecoveryToken(token), expiresAt, req.user!.id);
        revokeSessions(row.id);
      })();
      const resetPath = `/reset-password?token=${encodeURIComponent(token)}`;
      return {
        token,
        resetPath,
        resetUrl: config.publicUrl ? `${config.publicUrl}${resetPath}` : null,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/users/:id/logout-all",
    { preHandler: requirePerm("manageCredentials") },
    async (req, reply) => {
      const row = db.prepare("SELECT id, group_id FROM users WHERE id = ?").get(req.params.id) as
        { id: number; group_id: number | null } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (!canControlCredentials(req.user!.permissions.admin, row))
        return reply.code(403).send({ error: "only an admin can revoke an admin account" });
      revokeSessions(row.id);
      return { ok: true };
    }
  );
}
