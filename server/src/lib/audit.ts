import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../db.js";

const QUIET_ROUTES = new Set(["POST /api/notifications/seen"]);

interface AuditEvent {
  actorUserId?: number | null;
  actorUsername?: string | null;
  action: string;
  target?: string | null;
  status: number;
  remoteAddress?: string | null;
  detail?: Record<string, unknown>;
}

export function recordAuditEvent(event: AuditEvent): void {
  db.prepare(
    `INSERT INTO audit_log
       (actor_user_id, actor_username, action, target, status, remote_address, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.actorUserId ?? null,
    event.actorUsername?.slice(0, 128) ?? null,
    event.action.slice(0, 256),
    event.target?.slice(0, 512) ?? null,
    event.status,
    event.remoteAddress?.slice(0, 128) ?? null,
    JSON.stringify(event.detail ?? { ok: event.status < 400 })
  );
  db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)").run(
    `-${config.audit.retentionDays} days`
  );
  db.prepare(
    `DELETE FROM audit_log WHERE id NOT IN
       (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)`
  ).run(config.audit.maxRows);
}

function routeAction(req: FastifyRequest): string {
  const template = (req.routeOptions as { url?: string }).url || req.url.split("?")[0];
  return `${req.method} ${template}`.slice(0, 256);
}

function loginIdentity(req: FastifyRequest): string | null {
  if (req.user?.username) return req.user.username;
  if (!["/api/auth/login", "/api/auth/setup", "/api/auth/invite"].includes(req.url.split("?")[0]))
    return null;
  const username = (req.body as { username?: unknown } | undefined)?.username;
  return typeof username === "string" ? username.trim().slice(0, 128) || null : null;
}

export function shouldAudit(req: FastifyRequest): boolean {
  const action = routeAction(req);
  if (QUIET_ROUTES.has(action)) return false;
  if (action === "GET /api/config/export") return true;
  return req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

export function recordAudit(req: FastifyRequest, reply: FastifyReply): void {
  if (!shouldAudit(req)) return;
  try {
    const action = routeAction(req);
    const target = req.url.split("?")[0].slice(0, 512);
    const username = loginIdentity(req);
    const actorId =
      req.user && db.prepare("SELECT 1 FROM users WHERE id = ?").get(req.user.id)
        ? req.user.id
        : null;
    recordAuditEvent({
      actorUserId: actorId,
      actorUsername: username,
      action,
      target,
      status: reply.statusCode,
      remoteAddress: req.ip,
      detail: { ok: reply.statusCode < 400, sso: !!req.ssoLogin },
    });
  } catch (error) {
    req.log.error({ err: error }, "security audit write failed");
  }
}
