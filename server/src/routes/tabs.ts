import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requirePerm, requireUser } from "../auth/auth.js";
import type { User } from "../auth/auth.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import { hasOnlyKeys } from "../auth/validation.js";

interface TabBody {
  name: string;
  url: string;
  local_url?: string;
  icon?: string;
  grp?: string;
  sort?: number;
  open_mode?: "embed" | "new-tab";
  ping?: boolean;
  /** group ids allowed to see this berth; empty/omitted = everyone */
  allowed_groups?: number[];
}

/** JSON array of group ids, or [] for "visible to everyone". */
export function parseAllowed(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

export function serializeAllowed(groups: number[] | undefined): string {
  const clean = Array.isArray(groups)
    ? [...new Set(groups.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200)
    : [];
  return clean.length ? JSON.stringify(clean) : "";
}

/** Shape a DB row for the client, exposing allowed_groups as a real array. */
function toPublic(row: any) {
  return { ...row, allowed_groups: parseAllowed(row.allowed_groups) };
}

function validTabBody(value: unknown): value is Partial<TabBody> {
  if (
    !hasOnlyKeys(value, [
      "name",
      "url",
      "local_url",
      "icon",
      "grp",
      "sort",
      "open_mode",
      "ping",
      "allowed_groups",
    ])
  )
    return false;
  const b = value as Record<string, unknown>;
  return (
    (b.icon === undefined || (typeof b.icon === "string" && b.icon.length <= 64)) &&
    (b.grp === undefined || (typeof b.grp === "string" && b.grp.length <= 128)) &&
    (b.sort === undefined ||
      (Number.isInteger(b.sort) && Number(b.sort) >= -100_000 && Number(b.sort) <= 100_000)) &&
    (b.open_mode === undefined || b.open_mode === "embed" || b.open_mode === "new-tab") &&
    (b.ping === undefined || typeof b.ping === "boolean") &&
    (b.allowed_groups === undefined ||
      (Array.isArray(b.allowed_groups) &&
        b.allowed_groups.length <= 200 &&
        b.allowed_groups.every((id) => Number.isInteger(id) && id > 0)))
  );
}

export function canSee(row: { allowed_groups?: unknown }, user: User): boolean {
  // Managers see every berth so they can administer it; regular users are
  // filtered by the berth's allow-list (empty list = open to all).
  if (user.permissions.admin || user.permissions.manageBerths) return true;
  const allowed = parseAllowed(row.allowed_groups);
  if (allowed.length === 0) return true;
  return user.groupId != null && allowed.includes(user.groupId);
}

export function tabRoutes(app: FastifyInstance): void {
  app.get("/api/tabs", { preHandler: requireUser }, async (req) => {
    const rows = db.prepare("SELECT * FROM tabs ORDER BY sort, name").all() as any[];
    return rows
      .filter(
        (r) =>
          canSee(r, req.user!) &&
          normalizeHttpUrl(r.url) !== null &&
          normalizeHttpUrl(r.local_url ?? "", true) !== null
      )
      .map(toPublic);
  });

  app.post<{ Body: TabBody }>(
    "/api/tabs",
    { preHandler: requirePerm("manageBerths") },
    async (req, reply) => {
      const b = req.body ?? ({} as TabBody);
      if (!validTabBody(b)) return reply.code(400).send({ error: "invalid berth settings" });
      const url = normalizeHttpUrl(b.url);
      const localUrl = normalizeHttpUrl(b.local_url ?? "", true);
      if (
        typeof b.name !== "string" ||
        !b.name.trim() ||
        b.name.trim().length > 128 ||
        !url ||
        localUrl === null
      )
        return reply.code(400).send({ error: "valid name and http(s) URLs are required" });
      const info = db
        .prepare(
          "INSERT INTO tabs (name, url, local_url, icon, grp, sort, open_mode, ping, allowed_groups) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          b.name.trim(),
          url,
          localUrl,
          b.icon?.trim() || "globe",
          b.grp?.trim() || "",
          b.sort ?? 0,
          b.open_mode === "new-tab" ? "new-tab" : "embed",
          b.ping === false ? 0 : 1,
          serializeAllowed(b.allowed_groups)
        );
      return toPublic(db.prepare("SELECT * FROM tabs WHERE id = ?").get(info.lastInsertRowid));
    }
  );

  app.patch<{ Params: { id: string }; Body: Partial<TabBody> }>(
    "/api/tabs/:id",
    { preHandler: requirePerm("manageBerths") },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM tabs WHERE id = ?").get(req.params.id) as any;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.integration_id)
        return reply
          .code(409)
          .send({ error: "integration-managed berths are edited from integrations" });
      const b = req.body ?? {};
      if (!validTabBody(b)) return reply.code(400).send({ error: "invalid berth settings" });
      const url = b.url !== undefined ? normalizeHttpUrl(b.url) : row.url;
      const localUrl =
        b.local_url !== undefined ? normalizeHttpUrl(b.local_url, true) : row.local_url;
      if (
        url === null ||
        localUrl === null ||
        (b.name !== undefined &&
          (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 128))
      )
        return reply.code(400).send({ error: "valid name and http(s) URLs are required" });
      db.prepare(
        "UPDATE tabs SET name = ?, url = ?, local_url = ?, icon = ?, grp = ?, sort = ?, open_mode = ?, ping = ?, allowed_groups = ? WHERE id = ?"
      ).run(
        b.name?.trim() || row.name,
        url,
        localUrl,
        b.icon?.trim() || row.icon,
        b.grp !== undefined ? b.grp.trim() : row.grp,
        b.sort ?? row.sort,
        b.open_mode ?? row.open_mode,
        (b.ping ?? !!row.ping) ? 1 : 0,
        b.allowed_groups !== undefined ? serializeAllowed(b.allowed_groups) : row.allowed_groups,
        row.id
      );
      return toPublic(db.prepare("SELECT * FROM tabs WHERE id = ?").get(row.id));
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/tabs/:id",
    { preHandler: requirePerm("manageBerths") },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM tabs WHERE id = ?").get(req.params.id) as
        { integration_id?: number | null } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.integration_id)
        return reply
          .code(409)
          .send({ error: "integration-managed berths are removed from integrations" });
      db.prepare("DELETE FROM tabs WHERE id = ?").run(req.params.id);
      return { ok: true };
    }
  );
}
