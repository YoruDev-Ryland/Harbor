import { db } from "../db.js";
import {
  isAdminPermissions,
  resolvePermissions,
  sanitizePermissions,
  type PermissionSet,
} from "./permissions.js";

/** A permission group ("profile") that users belong to. */
export interface Group {
  id: number;
  name: string;
  /** stored flags exactly as configured */
  permissions: PermissionSet;
  /** effective flags (admin implies all) — what runtime checks use */
  effective: PermissionSet;
  is_default: boolean;
  memberCount: number;
}

function rowToGroup(row: any): Group {
  return {
    id: row.id,
    name: row.name,
    permissions: sanitizePermissions(row.permissions),
    effective: resolvePermissions(row.permissions),
    is_default: !!row.is_default,
    memberCount: Number(row.member_count) || 0,
  };
}

const SELECT = `
  SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS member_count
  FROM user_groups g`;

export function listGroups(): Group[] {
  return (db.prepare(`${SELECT} ORDER BY g.name`).all() as any[]).map(rowToGroup);
}

export function getGroup(id: number): Group | undefined {
  const row = db.prepare(`${SELECT} WHERE g.id = ?`).get(id);
  return row ? rowToGroup(row) : undefined;
}

/** Group assigned to SSO-provisioned users; falls back to the lowest id. */
export function defaultGroup(): Group | undefined {
  return (
    listGroups().find((g) => g.is_default) ??
    ((db.prepare(`${SELECT} ORDER BY g.id LIMIT 1`).get() as any)
      ? rowToGroup(db.prepare(`${SELECT} ORDER BY g.id LIMIT 1`).get())
      : undefined)
  );
}

export function adminGroup(): Group | undefined {
  return listGroups().find((g) => g.effective.admin);
}

/** How many users currently resolve to admin — the invariant we protect. */
export function adminUserCount(): number {
  const rows = db
    .prepare(
      "SELECT g.permissions AS perms FROM users u JOIN user_groups g ON g.id = u.group_id WHERE u.disabled = 0"
    )
    .all() as { perms: string }[];
  return rows.filter((r) => isAdminPermissions(r.perms)).length;
}
