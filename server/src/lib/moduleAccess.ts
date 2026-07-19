import { db, getSetting } from "../db.js";
import { resolvePermissions, type PermissionSet } from "../auth/permissions.js";
import type { NotifyCategory } from "./notify.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../auth/auth.js";
import { createHash } from "node:crypto";

/**
 * Which overview module each notification family belongs to. A user only gets
 * emails for a category if they can actually see that module — visibility is
 * governed by the shared default layout's per-widget group allow-list, exactly
 * like the dashboard itself. Categories with no module (e.g. "general") are
 * open to everyone.
 */
const CATEGORY_WIDGET: Partial<Record<NotifyCategory, string>> = {
  downloads: "downloads",
  services: "status",
  disk: "system",
  websites: "websites",
};

/** The group ids allowed to see a widget in the shared default ([] = everyone). */
export function allowedGroupsFor(widgetId: string): number[] {
  try {
    const raw = getSetting("widget_layout", "");
    const layout = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(layout)) return [];
    const item = layout.find((i) => i?.id === widgetId);
    return item && Array.isArray(item.allowed_groups)
      ? item.allowed_groups.map(Number).filter(Number.isFinite)
      : [];
  } catch {
    return [];
  }
}

/** Dashboard visibility is a server-side data boundary, not just a UI hint. */
export function canSeeWidget(user: User, widgetId: string): boolean {
  if (!user.permissions.viewOverview && !user.permissions.editLayout) return false;
  if (user.permissions.editLayout) return true;
  const allowed = allowedGroupsFor(widgetId);
  return allowed.length === 0 || (user.groupId != null && allowed.includes(user.groupId));
}

export function canSeeAnyWidget(user: User, widgetIds: readonly string[]): boolean {
  return widgetIds.some((id) => canSeeWidget(user, id));
}

export function requireWidget(...widgetIds: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!canSeeAnyWidget(req.user, widgetIds)) reply.code(403).send({ error: "forbidden" });
  };
}

/** A compact authorization scope for caches shared only by equivalent groups. */
export function moduleAccessScope(user: User): string {
  if (
    user.permissions.editLayout ||
    user.permissions.manageBerths ||
    user.permissions.manageIntegrations
  )
    return "all";
  const sourcePolicy = db
    .prepare(
      "SELECT integration_id, allowed_groups FROM tabs WHERE integration_id IS NOT NULL ORDER BY integration_id"
    )
    .all() as Array<{ integration_id: number; allowed_groups: string }>;
  const policyHash = createHash("sha256")
    .update(getSetting("widget_layout", ""))
    .update(JSON.stringify(sourcePolicy))
    .digest("hex")
    .slice(0, 12);
  return `group-${user.groupId ?? "none"}-${policyHash}`;
}

/** Restrict a source when its linked berth has a group allow-list. */
export function canUseIntegration(user: User, integrationId: number): boolean {
  if (
    user.permissions.admin ||
    user.permissions.editLayout ||
    user.permissions.manageBerths ||
    user.permissions.manageIntegrations
  )
    return true;
  const berth = db
    .prepare("SELECT allowed_groups FROM tabs WHERE integration_id = ?")
    .get(integrationId) as { allowed_groups: string } | undefined;
  if (!berth) return true;
  let allowed: number[] = [];
  try {
    const parsed = berth.allowed_groups ? JSON.parse(berth.allowed_groups) : [];
    if (Array.isArray(parsed)) allowed = parsed.map(Number).filter(Number.isFinite);
  } catch {
    return false;
  }
  return allowed.length === 0 || (user.groupId != null && allowed.includes(user.groupId));
}

/** Server-side gate mirroring the client's canSeeWidget — the enforcement half. */
export function canSeeCategory(
  groupId: number | null,
  permissions: PermissionSet,
  category: NotifyCategory
): boolean {
  const widgetId = CATEGORY_WIDGET[category];
  if (!widgetId) return true; // uncategorised events reach anyone opted in
  if (!permissions.viewOverview && !permissions.editLayout) return false;
  if (permissions.editLayout) return true; // managers/admins see every module
  const allowed = allowedGroupsFor(widgetId);
  if (allowed.length === 0) return true; // unrestricted module
  return groupId != null && allowed.includes(groupId);
}

/** Convenience for a raw group-permissions JSON string (as stored on a group). */
export function canSeeCategoryRaw(
  groupId: number | null,
  groupPermissions: unknown,
  category: NotifyCategory
): boolean {
  return canSeeCategory(groupId, resolvePermissions(groupPermissions), category);
}
