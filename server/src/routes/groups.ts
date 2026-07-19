import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireAdmin, requireAnyPerm } from "../auth/auth.js";
import { adminUserCount, getGroup, listGroups } from "../auth/groups.js";
import { PERMISSIONS, sanitizePermissions } from "../auth/permissions.js";
import { hasOnlyKeys, isPlainRecord } from "../auth/validation.js";

interface GroupBody {
  name: string;
  permissions?: Record<string, boolean>;
  is_default?: boolean;
}

/** Promote one group to the sole default (every provisioned SSO user lands here). */
function setSoleDefault(id: number): void {
  db.prepare("UPDATE user_groups SET is_default = CASE id WHEN ? THEN 1 ELSE 0 END").run(id);
}

export function groupRoutes(app: FastifyInstance): void {
  // The catalog of permission keys + human labels drives the group editor UI.
  app.get("/api/permissions", { preHandler: requireAdmin }, async () => PERMISSIONS);

  // Any signed-in user may read the group list (needed by the berth-visibility
  // and crew editors); it exposes no secrets, only names + permission flags.
  app.get(
    "/api/groups",
    {
      preHandler: requireAnyPerm(
        "admin",
        "editLayout",
        "manageBerths",
        "manageIntegrations",
        "manageSecrets",
        "manageUsers",
        "manageCredentials"
      ),
    },
    async () => listGroups()
  );

  // Defining permission profiles is inherently a Harbormaster action.
  app.post<{ Body: GroupBody }>("/api/groups", { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? ({} as GroupBody);
    if (
      !hasOnlyKeys(b, ["name", "permissions", "is_default"]) ||
      (b.is_default !== undefined && typeof b.is_default !== "boolean") ||
      (b.permissions !== undefined &&
        (!isPlainRecord(b.permissions) ||
          Object.values(b.permissions).some((value) => typeof value !== "boolean")))
    )
      return reply.code(400).send({ error: "invalid group settings" });
    if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 128)
      return reply.code(400).send({ error: "valid name is required" });
    const perms = sanitizePermissions(b.permissions);
    try {
      const info = db
        .prepare("INSERT INTO user_groups (name, permissions, is_default) VALUES (?, ?, 0)")
        .run(b.name.trim(), JSON.stringify(perms));
      const id = Number(info.lastInsertRowid);
      if (b.is_default) setSoleDefault(id);
      return getGroup(id);
    } catch {
      return reply.code(409).send({ error: "a group with that name already exists" });
    }
  });

  app.patch<{ Params: { id: string }; Body: GroupBody }>(
    "/api/groups/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const group = getGroup(Number(req.params.id));
      if (!group) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? ({} as GroupBody);
      if (
        !hasOnlyKeys(b, ["name", "permissions", "is_default"]) ||
        (b.is_default !== undefined && typeof b.is_default !== "boolean") ||
        (b.permissions !== undefined &&
          (!isPlainRecord(b.permissions) ||
            Object.values(b.permissions).some((value) => typeof value !== "boolean")))
      )
        return reply.code(400).send({ error: "invalid group settings" });

      if (
        b.name !== undefined &&
        (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 128)
      )
        return reply.code(400).send({ error: "valid name is required" });
      const name = typeof b.name === "string" ? b.name.trim() : group.name;
      const perms = b.permissions ? sanitizePermissions(b.permissions) : group.permissions;

      try {
        // Apply, then verify the last-admin invariant still holds; roll back if not.
        const apply = db.transaction(() => {
          db.prepare("UPDATE user_groups SET name = ?, permissions = ? WHERE id = ?").run(
            name,
            JSON.stringify(perms),
            group.id
          );
          if (b.is_default) setSoleDefault(group.id);
          if (adminUserCount() === 0) throw new Error("last-admin");
        });
        apply();
      } catch (err: any) {
        if (err?.message === "last-admin")
          return reply.code(400).send({
            error: "that change would leave no Harbormaster — grant admin elsewhere first",
          });
        if (String(err?.message).includes("UNIQUE"))
          return reply.code(409).send({ error: "a group with that name already exists" });
        throw err;
      }
      return getGroup(group.id);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/groups/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const group = getGroup(Number(req.params.id));
      if (!group) return reply.code(404).send({ error: "not found" });
      if (group.memberCount > 0)
        return reply.code(409).send({ error: "reassign this group's members before deleting it" });
      if (group.is_default)
        return reply.code(409).send({ error: "set another group as default first" });
      db.prepare("DELETE FROM user_groups WHERE id = ?").run(group.id);
      return { ok: true };
    }
  );
}
