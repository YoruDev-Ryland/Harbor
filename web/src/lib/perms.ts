import type { Permission, User } from "../types";

/** Does the user hold a permission? Server already folds `admin` into every flag. */
export function can(user: User | null | undefined, perm: Permission): boolean {
  return !!user?.permissions?.[perm];
}

/** Any permission that should reveal the Harbormaster (settings) area. */
const MANAGE_PERMS: Permission[] = [
  "manageBerths",
  "manageIntegrations",
  "manageSecrets",
  "manageSettings",
  "manageMonitors",
  "manageNotifications",
  "manageUsers",
  "manageCredentials",
];

export function canManageAnything(user: User | null | undefined): boolean {
  return !!user && MANAGE_PERMS.some((p) => can(user, p));
}
