import type { MeResponse } from "../types";
import { parseLayout } from "./layout";

/**
 * Can this user see a given overview module? Visibility is governed by the
 * shared default layout's per-widget group allow-list; users who can edit the
 * default (admins/editLayout) see every module. This is the single source of
 * truth used by both the dashboard and the Account notification options.
 */
export function canSeeWidget(me: MeResponse, widgetId: string): boolean {
  if (me.user?.permissions?.editLayout) return true;
  const item = parseLayout(me.defaultLayout).find((i) => i.id === widgetId);
  if (!item?.allowed_groups?.length) return true;
  const gid = me.user?.groupId ?? null;
  return gid != null && item.allowed_groups.includes(gid);
}
