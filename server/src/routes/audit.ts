import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/auth.js";
import { db } from "../db.js";

export function auditRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    "/api/audit",
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (Object.keys(req.query ?? {}).some((key) => !["limit", "before"].includes(key)))
        return reply.code(400).send({ error: "invalid audit query" });
      const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
      const before =
        req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        !Number.isSafeInteger(before) ||
        before < 1
      )
        return reply.code(400).send({ error: "invalid audit query" });
      return db
        .prepare(
          `SELECT id, actor_user_id, actor_username, action, target, status,
                  remote_address, detail_json, created_at
           FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`
        )
        .all(before, limit);
    }
  );
}
