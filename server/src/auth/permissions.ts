/**
 * Harbor permission model. A permission group (see auth/groups) holds a set of
 * these booleans; `admin` is the super-permission that implies all the others.
 * Keep this list small and orthogonal — one flag per thing a user can do.
 */

export const PERMISSIONS = [
  {
    key: "admin",
    label: "Harbormaster",
    desc: "Unrestricted control, including editing permission groups themselves.",
  },
  {
    key: "viewOverview",
    label: "View overview",
    desc: "See the overview dashboard and its widgets.",
  },
  {
    key: "editLayout",
    label: "Edit default layout",
    desc: "Set the shared default overview and which groups may see each module. (Everyone can personalise their own overview.)",
  },
  {
    key: "manageBerths",
    label: "Manage berths",
    desc: "Add, edit and remove berths, and choose which groups can see them.",
  },
  {
    key: "manageIntegrations",
    label: "Manage integrations",
    desc: "Add and configure service integrations without access to stored credentials.",
  },
  {
    key: "manageSecrets",
    label: "Manage service credentials",
    desc: "Enter or replace integration and shared SMTP credentials. Stored values remain write-only.",
  },
  {
    key: "controlDownloads",
    label: "Control downloads",
    desc: "Pause, resume, remove and reprioritise items in the Downloads widget.",
  },
  {
    key: "manageSettings",
    label: "Manage appearance",
    desc: "Change the instance title, themes, and shared display defaults.",
  },
  {
    key: "manageMonitors",
    label: "Manage site monitors",
    desc: "Configure URLs Harbor probes and run on-demand website checks.",
  },
  {
    key: "manageNotifications",
    label: "Manage notification delivery",
    desc: "Configure shared SMTP delivery and send administrator delivery tests.",
  },
  {
    key: "manageUsers",
    label: "Manage crew",
    desc: "Invite non-admin users, update their profiles, and assign non-admin permission groups.",
  },
  {
    key: "manageCredentials",
    label: "Manage credentials",
    desc: "Issue one-time password resets and revoke sessions for non-admin users.",
  },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as Permission[];

export type PermissionSet = Record<Permission, boolean>;

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string" && raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Effective permissions for runtime checks: `admin` implies everything. */
export function resolvePermissions(raw: unknown): PermissionSet {
  const parsed = parse(raw);
  const admin = !!parsed.admin;
  const out = {} as PermissionSet;
  for (const key of PERMISSION_KEYS) out[key] = admin || !!parsed[key];
  return out;
}

/** Normalize a client-supplied permissions object to just the known keys, for storage. */
export function sanitizePermissions(raw: unknown): PermissionSet {
  const parsed = parse(raw);
  const out = {} as PermissionSet;
  for (const key of PERMISSION_KEYS) out[key] = !!parsed[key];
  return out;
}

export function isAdminPermissions(raw: unknown): boolean {
  return !!parse(raw).admin;
}
