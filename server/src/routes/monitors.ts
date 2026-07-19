import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requirePerm } from "../auth/auth.js";
import { requireWidget } from "../lib/moduleAccess.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import { checkOne } from "../lib/siteChecker.js";
import { hasOnlyKeys } from "../auth/validation.js";

const requireManage = requirePerm("manageMonitors");

interface MonitorBody {
  name?: string;
  url?: string;
  enabled?: boolean;
  expect_status?: number | null;
  keyword?: string | null;
  sort?: number;
}

function validMonitorShape(value: unknown): value is MonitorBody {
  if (!hasOnlyKeys(value, ["name", "url", "enabled", "expect_status", "keyword", "sort"]))
    return false;
  const b = value as Record<string, unknown>;
  return (
    (b.enabled === undefined || typeof b.enabled === "boolean") &&
    (b.sort === undefined ||
      (Number.isInteger(b.sort) && Number(b.sort) >= -100_000 && Number(b.sort) <= 100_000))
  );
}

/** Attach a rolling 24h uptime percentage to each monitor row. */
function withUptime(row: any) {
  const stats = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS up FROM monitor_history WHERE monitor_id = ? AND checked_at > datetime('now','-1 day')"
    )
    .get(row.id) as { n: number; up: number };
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: !!row.enabled,
    expect_status: row.expect_status,
    keyword: row.keyword,
    sort: row.sort,
    state: row.last_state,
    status: row.last_status,
    latency: row.last_latency,
    message: row.last_message,
    checked_at: row.last_checked,
    uptime: stats.n > 0 ? Math.round((stats.up / stats.n) * 1000) / 10 : null,
  };
}

export function monitorRoutes(app: FastifyInstance): void {
  app.get("/api/monitors", { preHandler: requireManage }, async () => {
    const rows = db.prepare("SELECT * FROM monitors ORDER BY sort, name").all() as any[];
    return rows.map(withUptime);
  });

  // Widget readers receive operational state, never probe URLs, expected
  // responses, or secret-ish body keywords.
  app.get("/api/widgets/websites", { preHandler: requireWidget("websites") }, async () => {
    const rows = db.prepare("SELECT * FROM monitors ORDER BY sort, name").all() as any[];
    return rows.map((row) => ({ ...withUptime(row), url: "", expect_status: null, keyword: null }));
  });

  app.post<{ Body: MonitorBody }>(
    "/api/monitors",
    { preHandler: requireManage },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!validMonitorShape(b)) return reply.code(400).send({ error: "invalid monitor settings" });
      const url = normalizeHttpUrl(b.url);
      if (
        typeof b.name !== "string" ||
        !b.name.trim() ||
        b.name.trim().length > 128 ||
        !url ||
        (b.keyword != null && (typeof b.keyword !== "string" || b.keyword.length > 500)) ||
        (b.expect_status != null &&
          (!Number.isInteger(b.expect_status) || b.expect_status < 100 || b.expect_status > 599))
      )
        return reply.code(400).send({ error: "valid name and http(s) URL are required" });
      const info = db
        .prepare(
          "INSERT INTO monitors (name, url, enabled, expect_status, keyword, sort) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          b.name.trim(),
          url,
          b.enabled === false ? 0 : 1,
          b.expect_status || null,
          b.keyword?.trim() || null,
          b.sort ?? 0
        );
      // check it immediately so the widget isn't blank until the next tick
      checkOne(Number(info.lastInsertRowid)).catch(() => {});
      const row = db.prepare("SELECT * FROM monitors WHERE id = ?").get(info.lastInsertRowid);
      return withUptime(row);
    }
  );

  app.patch<{ Params: { id: string }; Body: MonitorBody }>(
    "/api/monitors/:id",
    { preHandler: requireManage },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM monitors WHERE id = ?").get(req.params.id) as any;
      if (!row) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? {};
      if (!validMonitorShape(b)) return reply.code(400).send({ error: "invalid monitor settings" });
      const url = b.url !== undefined ? normalizeHttpUrl(b.url) : row.url;
      if (
        url === null ||
        (b.name !== undefined &&
          (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 128)) ||
        (b.keyword != null && (typeof b.keyword !== "string" || b.keyword.length > 500)) ||
        (b.expect_status != null &&
          (!Number.isInteger(b.expect_status) || b.expect_status < 100 || b.expect_status > 599))
      )
        return reply.code(400).send({ error: "invalid monitor settings" });
      const urlChanged = url !== row.url;
      db.prepare(
        `UPDATE monitors SET name = ?, url = ?, enabled = ?, expect_status = ?, keyword = ?, sort = ?,
         baseline_len = ? WHERE id = ?`
      ).run(
        b.name?.trim() || row.name,
        url,
        b.enabled === undefined ? row.enabled : b.enabled ? 1 : 0,
        b.expect_status === undefined ? row.expect_status : b.expect_status || null,
        b.keyword === undefined ? row.keyword : b.keyword?.trim() || null,
        b.sort ?? row.sort,
        urlChanged ? null : row.baseline_len, // forget the learned baseline if the URL moved
        row.id
      );
      checkOne(row.id).catch(() => {});
      return withUptime(db.prepare("SELECT * FROM monitors WHERE id = ?").get(row.id));
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/monitors/:id",
    { preHandler: requireManage },
    async (req) => {
      db.prepare("DELETE FROM monitor_history WHERE monitor_id = ?").run(req.params.id);
      db.prepare("DELETE FROM monitors WHERE id = ?").run(req.params.id);
      return { ok: true };
    }
  );

  // Run a check right now (the "test" button).
  app.post<{ Params: { id: string } }>(
    "/api/monitors/:id/check",
    { preHandler: requireManage },
    async (req, reply) => {
      try {
        const result = await checkOne(Number(req.params.id));
        return result;
      } catch (err: any) {
        return reply.code(404).send({ error: err?.message ?? "not found" });
      }
    }
  );
}
