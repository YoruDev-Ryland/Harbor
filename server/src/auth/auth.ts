import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../db.js";
import { createSessionToken, verifySessionToken } from "../lib/crypto.js";
import { ipTrusted } from "../lib/net.js";
import { resolvePermissions, type Permission, type PermissionSet } from "./permissions.js";
import { adminGroup, defaultGroup } from "./groups.js";
import { consumeSetupToken } from "./setupToken.js";
import { recordAuditEvent } from "../lib/audit.js";

export interface User {
  id: number;
  username: string;
  email: string | null;
  /** derived from the group: admin when the group grants the `admin` permission */
  role: "admin" | "user";
  theme: string;
  has_password: boolean;
  disabled: boolean;
  groupId: number | null;
  groupName: string | null;
  permissions: PermissionSet;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    /** true when the user arrived via forward-auth headers this request */
    ssoLogin: boolean;
  }
}

const COOKIE = "harbor_session";

/** Load a user by id or username, joining their group so permissions resolve. */
const USER_QUERY = `
  SELECT u.*, g.name AS group_name, g.permissions AS group_permissions
  FROM users u LEFT JOIN user_groups g ON g.id = u.group_id`;

function rowToUser(row: any): User {
  // A user should always have a group post-migration; fall back to the default
  // group's permissions if one is somehow missing rather than granting nothing.
  const permSource =
    row.group_permissions != null ? row.group_permissions : (defaultGroup()?.permissions ?? {});
  const permissions = resolvePermissions(permSource);
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: permissions.admin ? "admin" : "user",
    theme: row.theme,
    has_password: !!row.password_hash,
    disabled: !!row.disabled,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    permissions,
  };
}

export function getUserById(id: number): User | null {
  const row = db.prepare(`${USER_QUERY} WHERE u.id = ?`).get(id);
  return row ? rowToUser(row) : null;
}

export function findUserByName(username: string): (User & { password_hash: string | null }) | null {
  const row = db.prepare(`${USER_QUERY} WHERE u.username = ?`).get(username) as any;
  return row ? { ...rowToUser(row), password_hash: row.password_hash } : null;
}

/**
 * Resolve forward-auth through an immutable provider/subject binding. For a
 * safe, one-time migration, an exact username match with no provider binding
 * may be claimed; email matching is intentionally never used.
 */
export function provisionSsoUser(provider: string, rawIdentity: string): User | null {
  const subject = rawIdentity.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@:+/-]{0,253}$/.test(subject)) return null;

  const resolve = db.transaction(() => {
    const mapped = db
      .prepare(
        `SELECT u.id FROM auth_identities i
         JOIN users u ON u.id = i.user_id
         WHERE i.provider = ? AND i.subject = ?`
      )
      .get(provider, subject) as { id: number } | undefined;
    if (mapped) {
      db.prepare(
        "UPDATE auth_identities SET display = ?, last_seen = datetime('now') WHERE provider = ? AND subject = ?"
      ).run(rawIdentity.trim().slice(0, 254), provider, subject);
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(mapped.id);
      return mapped.id;
    }

    const usernameMatch = db
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .get(subject) as { id: number; password_hash: string | null } | undefined;
    let userId: number;
    if (usernameMatch) {
      // Passwordless rows are legacy SSO-provisioned accounts from before the
      // identity table. Never let an SSO subject silently claim a local
      // password-bearing account; an administrator must bind that explicitly.
      if (usernameMatch.password_hash) throw new Error("sso identity conflict");
      const existingProviderIdentity = db
        .prepare("SELECT id FROM auth_identities WHERE provider = ? AND user_id = ?")
        .get(provider, usernameMatch.id);
      if (existingProviderIdentity) throw new Error("sso identity conflict");
      userId = usernameMatch.id;
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(userId);
    } else {
      const isAdmin = config.adminUsers.includes(subject);
      const email = subject.includes("@") ? subject : null;
      const group = isAdmin ? (adminGroup() ?? defaultGroup()) : defaultGroup();
      const info = db
        .prepare(
          "INSERT INTO users (username, email, role, group_id, last_login) VALUES (?, ?, ?, ?, datetime('now'))"
        )
        .run(subject, email, isAdmin ? "admin" : "user", group?.id ?? null);
      userId = Number(info.lastInsertRowid);
    }
    db.prepare(
      "INSERT INTO auth_identities (provider, subject, user_id, display) VALUES (?, ?, ?, ?)"
    ).run(provider, subject, userId, rawIdentity.trim().slice(0, 254));
    return userId;
  });

  const user = getUserById(resolve());
  return user && !user.disabled ? user : null;
}

export function setSessionCookie(reply: FastifyReply, userId: number): void {
  const row = db.prepare("SELECT session_version FROM users WHERE id = ?").get(userId) as
    { session_version: number } | undefined;
  if (!row) return;
  reply.setCookie(COOKIE, createSessionToken(userId, row.session_version), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
    maxAge: config.sessionDays * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}

export function revokeSessions(userId: number): void {
  db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(userId);
}

/**
 * Resolves req.user on every request:
 *  1. valid session cookie, else
 *  2. forward-auth header from a trusted proxy (auto-provisions + sets cookie).
 */
export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest("user", null);
  app.decorateRequest("ssoLogin", false);

  app.addHook("onRequest", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) {
      const session = verifySessionToken(token);
      if (session) {
        const row = db
          .prepare("SELECT session_version, disabled FROM users WHERE id = ?")
          .get(session.userId) as { session_version: number; disabled: number } | undefined;
        if (row && !row.disabled && row.session_version === session.sessionVersion) {
          req.user = getUserById(session.userId);
          if (req.user) return;
        }
        clearSessionCookie(reply);
      }
    }

    if (!config.authProxy.enabled) return;
    // Trust is decided by the direct peer (Traefik's socket address), not
    // req.ip — with trustProxy on, req.ip is the original client's public IP.
    const peer = req.raw.socket?.remoteAddress ?? req.ip;
    if (!ipTrusted(peer, config.authProxy.trusted)) return;
    for (const header of config.authProxy.headers) {
      const value = req.headers[header];
      const identity = (Array.isArray(value) ? value[0] : value)?.trim();
      if (identity) {
        try {
          req.user = provisionSsoUser(config.authProxy.provider, identity);
        } catch (error) {
          req.log.warn({ error, provider: config.authProxy.provider }, "SSO identity conflict");
          recordAuditEvent({
            actorUsername: identity.toLowerCase(),
            action: "SSO login",
            target: config.authProxy.provider,
            status: 403,
            remoteAddress: peer,
          });
          return reply.code(403).send({ error: "SSO identity could not be resolved" });
        }
        if (!req.user) return reply.code(403).send({ error: "account unavailable" });
        // SSO provisioning makes local first-run setup unavailable; discard its
        // one-time token just as the local setup route does.
        consumeSetupToken();
        req.ssoLogin = true;
        setSessionCookie(reply, req.user.id);
        recordAuditEvent({
          actorUserId: req.user.id,
          actorUsername: req.user.username,
          action: "SSO login",
          target: config.authProxy.provider,
          status: 200,
          remoteAddress: peer,
        });
        return;
      }
    }
  });
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) reply.code(401).send({ error: "unauthenticated" });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) reply.code(401).send({ error: "unauthenticated" });
  else if (!req.user.permissions.admin) reply.code(403).send({ error: "forbidden" });
}

/** preHandler factory: allow admins, or users whose group grants `perm`. */
export function requirePerm(perm: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!req.user.permissions[perm]) reply.code(403).send({ error: "forbidden" });
  };
}

/** preHandler factory: allow a user holding at least one listed permission. */
export function requireAnyPerm(...perms: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!perms.some((perm) => req.user!.permissions[perm]))
      reply.code(403).send({ error: "forbidden" });
  };
}
