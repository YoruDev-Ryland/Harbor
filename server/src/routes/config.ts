import type { FastifyInstance } from "fastify";
import { db, schemaVersion } from "../db.js";
import { requireAdmin } from "../auth/auth.js";
import { adminUserCount } from "../auth/groups.js";
import { sanitizePermissions } from "../auth/permissions.js";
import { hasOnlyKeys, validEmail, validPhone, validUsername } from "../auth/validation.js";
import { secretFingerprint } from "../lib/crypto.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import { getAdapter } from "../modules/registry.js";

const EXPORT_VERSION = 3;
const SECTION_KEYS = [
  "settings",
  "groups",
  "integrations",
  "tabs",
  "users",
  "monitors",
  "notifications",
  "audit",
] as const;
type Section = (typeof SECTION_KEYS)[number];
type ImportSections = Record<Section, boolean>;

interface ImportBody {
  data?: any;
  include?: Partial<ImportSections>;
}

function safeId(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function nullableId(value: unknown): boolean {
  return value == null || safeId(value);
}
function shortText(value: unknown, max: number, optional = false): boolean {
  return (
    (optional && (value === undefined || value === null)) ||
    (typeof value === "string" && value.length <= max && !/[\r\n]/.test(value))
  );
}
function text(value: unknown, max: number, optional = false): boolean {
  return (
    (optional && (value === undefined || value === null)) ||
    (typeof value === "string" && value.length <= max)
  );
}
function boolish(value: unknown): boolean {
  return [0, 1, false, true].includes(value as any);
}
function integerArrayJson(value: unknown, max: number): boolean {
  if (value === "" || value === undefined) return true;
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const parsed = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.length <= max &&
      parsed.every((item) => Number.isInteger(item) && item > 0)
    );
  } catch {
    return false;
  }
}

const caps: Record<string, number> = {
  settings: 500,
  user_groups: 200,
  integrations: 500,
  tabs: 1_000,
  users: 2_000,
  auth_identities: 4_000,
  monitors: 2_000,
  monitor_history: 50_000,
  notifications: 50_000,
  user_push_endpoints: 2_000,
  audit_log: 50_000,
};

function validImport(data: any, include: ImportSections): string | null {
  if (
    !hasOnlyKeys(data, [
      "harbor",
      "version",
      "schemaVersion",
      "exportedAt",
      "keyFingerprint",
      "ephemeralExcluded",
      "settings",
      "user_groups",
      "integrations",
      "tabs",
      "users",
      "auth_identities",
      "monitors",
      "monitor_history",
      "notifications",
      "user_push_endpoints",
      "audit_log",
    ]) ||
    data.harbor !== "backup" ||
    data.version !== EXPORT_VERSION ||
    !Number.isInteger(data.schemaVersion) ||
    data.schemaVersion < 1 ||
    data.schemaVersion > schemaVersion ||
    typeof data.exportedAt !== "string" ||
    data.keyFingerprint !== secretFingerprint()
  )
    return `only Harbor backup version ${EXPORT_VERSION} from this master key and a compatible schema can be restored`;

  const required: string[] = [];
  if (include.settings) required.push("settings");
  if (include.groups) required.push("user_groups");
  if (include.integrations) required.push("integrations");
  if (include.tabs) required.push("tabs");
  if (include.users) required.push("users", "auth_identities", "user_push_endpoints");
  if (include.monitors) required.push("monitors", "monitor_history");
  if (include.notifications) required.push("notifications");
  if (include.audit) required.push("audit_log");
  if (required.some((key) => !Array.isArray(data[key]) || data[key].length > caps[key]))
    return "backup section is missing or exceeds its record limit";

  if (
    include.settings &&
    data.settings.some(
      (row: any) =>
        !hasOnlyKeys(row, ["key", "value"]) || !shortText(row.key, 128) || !text(row.value, 256_000)
    )
  )
    return "invalid settings record";
  if (
    include.groups &&
    data.user_groups.some(
      (row: any) =>
        !hasOnlyKeys(row, ["id", "name", "permissions", "is_default", "created_at"]) ||
        !safeId(row.id) ||
        !shortText(row.name, 128) ||
        !text(row.permissions, 16_000) ||
        !boolish(row.is_default) ||
        !shortText(row.created_at, 64, true)
    )
  )
    return "invalid group record";
  if (
    include.integrations &&
    data.integrations.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "type",
          "name",
          "url",
          "public_url",
          "secret",
          "enabled",
          "use_downloads",
          "use_calendar",
          "use_status",
        ]) ||
        !safeId(row.id) ||
        typeof row.type !== "string" ||
        !getAdapter(row.type) ||
        !shortText(row.name, 128) ||
        !normalizeHttpUrl(row.url) ||
        normalizeHttpUrl(row.public_url ?? "", true) === null ||
        !text(row.secret ?? "", 100_000) ||
        ["enabled", "use_downloads", "use_calendar", "use_status"].some((key) => !boolish(row[key]))
    )
  )
    return "invalid integration record";
  if (
    include.tabs &&
    data.tabs.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "name",
          "url",
          "local_url",
          "icon",
          "grp",
          "sort",
          "open_mode",
          "ping",
          "integration_id",
          "allowed_groups",
        ]) ||
        !safeId(row.id) ||
        !shortText(row.name, 128) ||
        !normalizeHttpUrl(row.url) ||
        normalizeHttpUrl(row.local_url ?? "", true) === null ||
        !shortText(row.icon, 64) ||
        !shortText(row.grp, 128) ||
        !Number.isInteger(row.sort) ||
        !["embed", "new-tab"].includes(row.open_mode) ||
        !boolish(row.ping) ||
        !nullableId(row.integration_id) ||
        !integerArrayJson(row.allowed_groups, 200)
    )
  )
    return "invalid berth record";
  if (
    include.users &&
    data.users.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "username",
          "email",
          "phone",
          "password_hash",
          "role",
          "theme",
          "group_id",
          "notify_email",
          "notify_prefs",
          "download_scope",
          "request_email",
          "layout",
          "ical_token_hash",
          "ical_token_last_used",
          "disabled",
          "session_version",
          "created_at",
          "last_login",
          "notifications_seen_at",
        ]) ||
        !safeId(row.id) ||
        !validUsername(row.username) ||
        !validEmail(row.email ?? "") ||
        !validPhone(row.phone ?? undefined) ||
        !text(row.password_hash, 1_024, true) ||
        !["admin", "user"].includes(row.role) ||
        !shortText(row.theme, 32) ||
        !nullableId(row.group_id) ||
        !boolish(row.notify_email) ||
        !text(row.notify_prefs, 16_000) ||
        !["all", "requested"].includes(row.download_scope) ||
        !validEmail(row.request_email ?? "") ||
        !text(row.layout, 64_000) ||
        !shortText(row.ical_token_hash, 64, true) ||
        !shortText(row.ical_token_last_used, 64, true) ||
        !boolish(row.disabled) ||
        !Number.isInteger(row.session_version) ||
        row.session_version < 0
    )
  )
    return "invalid user record";
  if (
    include.users &&
    data.auth_identities.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "provider",
          "subject",
          "user_id",
          "display",
          "created_at",
          "last_seen",
        ]) ||
        !safeId(row.id) ||
        !safeId(row.user_id) ||
        !shortText(row.provider, 32) ||
        !shortText(row.subject, 256) ||
        !shortText(row.display, 256, true)
    )
  )
    return "invalid identity record";
  if (
    include.users &&
    data.user_push_endpoints.some(
      (row: any) =>
        !hasOnlyKeys(row, ["user_id", "enabled", "url", "topic", "token_enc", "updated_at"]) ||
        !safeId(row.user_id) ||
        !boolish(row.enabled) ||
        !normalizeHttpUrl(row.url) ||
        !/^[A-Za-z0-9_-]{0,64}$/.test(row.topic) ||
        !text(row.token_enc, 100_000) ||
        !shortText(row.updated_at, 64, true)
    )
  )
    return "invalid private push record";
  if (
    include.monitors &&
    data.monitors.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "name",
          "url",
          "enabled",
          "expect_status",
          "keyword",
          "sort",
          "baseline_len",
          "last_state",
          "last_status",
          "last_latency",
          "last_message",
          "last_checked",
          "created_at",
        ]) ||
        !safeId(row.id) ||
        !shortText(row.name, 128) ||
        !normalizeHttpUrl(row.url) ||
        !boolish(row.enabled) ||
        (row.expect_status != null &&
          (!Number.isInteger(row.expect_status) ||
            row.expect_status < 100 ||
            row.expect_status > 599)) ||
        !text(row.keyword, 512, true) ||
        !Number.isInteger(row.sort) ||
        (row.baseline_len != null &&
          (!Number.isInteger(row.baseline_len) || row.baseline_len < 0)) ||
        !shortText(row.last_state, 32, true) ||
        !text(row.last_message, 2_000, true)
    )
  )
    return "invalid monitor record";
  if (
    include.monitors &&
    data.monitor_history.some(
      (row: any) =>
        !hasOnlyKeys(row, ["monitor_id", "checked_at", "ok", "status", "latency"]) ||
        !safeId(row.monitor_id) ||
        !shortText(row.checked_at, 64) ||
        !boolish(row.ok)
    )
  )
    return "invalid monitor history record";
  if (
    include.notifications &&
    data.notifications.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "user_id",
          "kind",
          "title",
          "body",
          "category",
          "event_key",
          "created_at",
          "read_at",
        ]) ||
        !safeId(row.id) ||
        !safeId(row.user_id) ||
        !["info", "success", "warn", "error"].includes(row.kind) ||
        !text(row.title, 512) ||
        !text(row.body, 4_096) ||
        !shortText(row.category, 32) ||
        !shortText(row.event_key, 512, true)
    )
  )
    return "invalid notification record";
  if (
    include.audit &&
    data.audit_log.some(
      (row: any) =>
        !hasOnlyKeys(row, [
          "id",
          "actor_user_id",
          "actor_username",
          "action",
          "target",
          "status",
          "remote_address",
          "detail_json",
          "created_at",
        ]) ||
        !safeId(row.id) ||
        !nullableId(row.actor_user_id) ||
        !shortText(row.actor_username, 128, true) ||
        !shortText(row.action, 256) ||
        !shortText(row.target, 512, true) ||
        !Number.isInteger(row.status) ||
        row.status < 100 ||
        row.status > 599 ||
        !shortText(row.remote_address, 128, true) ||
        !text(row.detail_json, 4_096) ||
        !shortText(row.created_at, 64)
    )
  )
    return "invalid audit record";
  return null;
}

export function configRoutes(app: FastifyInstance): void {
  app.get("/api/config/export", { preHandler: requireAdmin }, async (_req, reply) => {
    const snapshot = {
      harbor: "backup",
      version: EXPORT_VERSION,
      schemaVersion,
      exportedAt: new Date().toISOString(),
      keyFingerprint: secretFingerprint(),
      ephemeralExcluded: ["password_resets", "invitations"],
      settings: db.prepare("SELECT key, value FROM settings ORDER BY key").all(),
      user_groups: db.prepare("SELECT * FROM user_groups ORDER BY id").all(),
      integrations: db.prepare("SELECT * FROM integrations ORDER BY id").all(),
      tabs: db.prepare("SELECT * FROM tabs ORDER BY id").all(),
      users: db
        .prepare(
          `SELECT id, username, email, phone, password_hash, role, theme, group_id,
                notify_email, notify_prefs, download_scope, request_email, layout,
                ical_token_hash, ical_token_last_used, disabled, session_version,
                created_at, last_login, notifications_seen_at
         FROM users ORDER BY id`
        )
        .all(),
      auth_identities: db.prepare("SELECT * FROM auth_identities ORDER BY id").all(),
      monitors: db.prepare("SELECT * FROM monitors ORDER BY id").all(),
      monitor_history: db.prepare("SELECT * FROM monitor_history ORDER BY checked_at").all(),
      notifications: db.prepare("SELECT * FROM notifications ORDER BY id").all(),
      user_push_endpoints: db.prepare("SELECT * FROM user_push_endpoints ORDER BY user_id").all(),
      audit_log: db.prepare("SELECT * FROM audit_log ORDER BY id").all(),
    };
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header("Content-Disposition", `attachment; filename="harbor-sensitive-backup-${date}.json"`)
      .header("Cache-Control", "no-store");
    return snapshot;
  });

  app.post<{ Body: ImportBody }>(
    "/api/config/import",
    { preHandler: requireAdmin, bodyLimit: 16 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.data !== undefined && !hasOnlyKeys(body, ["data", "include"]))
        return reply.code(400).send({ error: "invalid restore request" });
      if (
        body.include !== undefined &&
        (!hasOnlyKeys(body.include, SECTION_KEYS) ||
          Object.values(body.include).some((value) => typeof value !== "boolean"))
      )
        return reply.code(400).send({ error: "invalid restore selection" });
      const data = body.data ?? body;
      const include = Object.fromEntries(
        SECTION_KEYS.map((section) => [section, body.include?.[section] ?? true])
      ) as ImportSections;
      const invalid = validImport(data, include);
      if (invalid) return reply.code(400).send({ error: invalid });

      try {
        db.transaction(() => {
          if (include.users) {
            db.exec(`
              DELETE FROM password_resets;
              DELETE FROM invitations;
              DELETE FROM auth_identities;
              DELETE FROM user_push_endpoints;
              DELETE FROM notifications;
              DELETE FROM users;
            `);
          } else if (include.notifications) {
            db.exec("DELETE FROM notifications");
          }
          if (include.tabs) db.exec("DELETE FROM tabs");
          if (include.groups) db.exec("DELETE FROM user_groups");
          if (include.integrations) db.exec("DELETE FROM integrations");
          if (include.monitors) {
            db.exec("DELETE FROM monitor_history; DELETE FROM monitors;");
          }
          if (include.settings) db.exec("DELETE FROM settings");
          if (include.audit) db.exec("DELETE FROM audit_log");

          if (include.settings) {
            const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
            for (const row of data.settings) insert.run(row.key, row.value);
          }
          if (include.groups) {
            const insert = db.prepare(
              "INSERT INTO user_groups (id, name, permissions, is_default, created_at) VALUES (?, ?, ?, ?, ?)"
            );
            for (const row of data.user_groups)
              insert.run(
                row.id,
                row.name,
                JSON.stringify(sanitizePermissions(row.permissions)),
                row.is_default ? 1 : 0,
                row.created_at
              );
          }
          if (include.integrations) {
            const insert = db.prepare(
              `INSERT INTO integrations
                 (id, type, name, url, public_url, secret, enabled, use_downloads, use_calendar, use_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.integrations)
              insert.run(
                row.id,
                row.type,
                row.name,
                row.url,
                row.public_url,
                row.secret,
                row.enabled ? 1 : 0,
                row.use_downloads ? 1 : 0,
                row.use_calendar ? 1 : 0,
                row.use_status ? 1 : 0
              );
          }
          if (include.tabs) {
            const insert = db.prepare(
              `INSERT INTO tabs
                 (id, name, url, local_url, icon, grp, sort, open_mode, ping, integration_id, allowed_groups)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.tabs)
              insert.run(
                row.id,
                row.name,
                row.url,
                row.local_url,
                row.icon,
                row.grp,
                row.sort,
                row.open_mode,
                row.ping ? 1 : 0,
                row.integration_id,
                row.allowed_groups
              );
          }
          if (include.users) {
            const insertUser = db.prepare(
              `INSERT INTO users
                 (id, username, email, phone, password_hash, role, theme, group_id,
                  notify_email, notify_prefs, download_scope, request_email, layout,
                  ical_token_hash, ical_token_last_used, disabled, session_version,
                  created_at, last_login, notifications_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.users)
              insertUser.run(
                row.id,
                row.username,
                row.email,
                row.phone,
                row.password_hash,
                row.role,
                row.theme,
                row.group_id,
                row.notify_email ? 1 : 0,
                row.notify_prefs,
                row.download_scope,
                row.request_email,
                row.layout,
                row.ical_token_hash,
                row.ical_token_last_used,
                row.disabled ? 1 : 0,
                Number(row.session_version) + 1,
                row.created_at,
                row.last_login,
                row.notifications_seen_at
              );
            const identity = db.prepare(
              `INSERT INTO auth_identities
                 (id, provider, subject, user_id, display, created_at, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.auth_identities)
              identity.run(
                row.id,
                row.provider,
                row.subject,
                row.user_id,
                row.display,
                row.created_at,
                row.last_seen
              );
            const push = db.prepare(
              `INSERT INTO user_push_endpoints
                 (user_id, enabled, url, topic, token_enc, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.user_push_endpoints)
              push.run(
                row.user_id,
                row.enabled ? 1 : 0,
                row.url,
                row.topic,
                row.token_enc,
                row.updated_at
              );
          }
          if (include.monitors) {
            const monitor = db.prepare(
              `INSERT INTO monitors
                 (id, name, url, enabled, expect_status, keyword, sort, baseline_len,
                  last_state, last_status, last_latency, last_message, last_checked, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.monitors)
              monitor.run(
                row.id,
                row.name,
                row.url,
                row.enabled ? 1 : 0,
                row.expect_status,
                row.keyword,
                row.sort,
                row.baseline_len,
                row.last_state,
                row.last_status,
                row.last_latency,
                row.last_message,
                row.last_checked,
                row.created_at
              );
            const history = db.prepare(
              "INSERT INTO monitor_history (monitor_id, checked_at, ok, status, latency) VALUES (?, ?, ?, ?, ?)"
            );
            for (const row of data.monitor_history)
              history.run(row.monitor_id, row.checked_at, row.ok ? 1 : 0, row.status, row.latency);
          }
          if (include.notifications) {
            const notification = db.prepare(
              `INSERT INTO notifications
                 (id, user_id, kind, title, body, category, event_key, created_at, read_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.notifications)
              notification.run(
                row.id,
                row.user_id,
                row.kind,
                row.title,
                row.body,
                row.category,
                row.event_key,
                row.created_at,
                row.read_at
              );
          }
          if (include.audit) {
            const audit = db.prepare(
              `INSERT INTO audit_log
                 (id, actor_user_id, actor_username, action, target, status, remote_address, detail_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of data.audit_log)
              audit.run(
                row.id,
                row.actor_user_id,
                row.actor_username,
                row.action,
                row.target,
                row.status,
                row.remote_address,
                row.detail_json,
                row.created_at
              );
          }
          if (adminUserCount() === 0) throw new Error("no-admin");
          const violations = db.prepare("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error("foreign-key-check");
        })();
      } catch (error: any) {
        const reason =
          error?.message === "no-admin"
            ? "the result would have no enabled administrator"
            : error?.message === "foreign-key-check"
              ? "the backup contains broken references"
              : (error?.message ?? "invalid data");
        return reply.code(400).send({ error: `restore aborted and rolled back: ${reason}` });
      }
      return { ok: true, schemaVersion };
    }
  );
}
