import type { NotifyCategory } from "../types";

/** Notification families a user can individually opt in/out of (email). Each ties
 *  to the overview module it belongs to, so the option is only offered to users
 *  who can see that module. Mirrors the server's notify categories. */
export const NOTIFY_CATEGORIES: Array<{
  category: NotifyCategory;
  /** the overview widget id this category belongs to */
  widget: string;
  label: string;
  hint: string;
}> = [
  {
    category: "downloads",
    widget: "downloads",
    label: "Downloads finished",
    hint: "When a grab completes.",
  },
  {
    category: "services",
    widget: "status",
    label: "Service up / down",
    hint: "When a berth or integration changes reachability.",
  },
  {
    category: "disk",
    widget: "system",
    label: "Low disk space",
    hint: "When a monitored host runs low.",
  },
  {
    category: "websites",
    widget: "websites",
    label: "Website status",
    hint: "When a watched site goes down, recovers or changes.",
  },
];

/** Effective per-category opt-in: an explicit override wins, else the master switch. */
export function categoryEnabled(
  category: NotifyCategory,
  notifyEmail: number | boolean,
  prefsJson: string | null
): boolean {
  let prefs: Record<string, boolean> = {};
  try {
    if (prefsJson) prefs = JSON.parse(prefsJson);
  } catch {
    /* fall back to master switch */
  }
  return category in prefs ? !!prefs[category] : !!notifyEmail;
}
