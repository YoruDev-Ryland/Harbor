import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { resolvePermissions } from "./auth/permissions.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

export const db = new Database(config.dbPath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

export const schemaVersion = runMigrations(db);
if (schemaVersion !== LATEST_SCHEMA_VERSION)
  throw new Error(`database schema stopped at ${schemaVersion}; expected ${LATEST_SCHEMA_VERSION}`);

/** Keep persistent account/secret/activity files private from other host users. */
export function enforceDataPermissions(): void {
  fs.chmodSync(config.dataDir, 0o700);
  for (const file of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`${path.basename(file)} must be a regular file`);
    fs.chmodSync(file, 0o600);
  }
}
enforceDataPermissions();

/** Seed starter groups and attach users from databases predating groups. */
function seedGroups(): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM user_groups").get() as { n: number }).n;
  if (count === 0) {
    db.prepare("INSERT INTO user_groups (name, permissions, is_default) VALUES (?, ?, 0)").run(
      "Administrators",
      JSON.stringify({ admin: true })
    );
    db.prepare("INSERT INTO user_groups (name, permissions, is_default) VALUES (?, ?, 1)").run(
      "Crew",
      JSON.stringify({ viewOverview: true })
    );
  }
  const groups = db.prepare("SELECT id, permissions, is_default FROM user_groups").all() as Array<{
    id: number;
    permissions: string;
    is_default: number;
  }>;
  const adminGroup = groups.find((group) => resolvePermissions(group.permissions).admin);
  const fallback = groups.find((group) => group.is_default) ?? groups[0];
  if (!fallback) return;
  const users = db.prepare("SELECT id, role FROM users WHERE group_id IS NULL").all() as Array<{
    id: number;
    role: string | null;
  }>;
  const update = db.prepare("UPDATE users SET group_id = ? WHERE id = ?");
  for (const user of users)
    update.run(user.role === "admin" && adminGroup ? adminGroup.id : fallback.id, user.id);
}
seedGroups();

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function databaseReady(): boolean {
  try {
    db.prepare("SELECT 1 AS ok").get();
    if (db.pragma("quick_check(1)", { simple: true }) !== "ok") return false;
    fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let closed = false;
export function closeDatabase(): void {
  if (closed) return;
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  closed = true;
}
