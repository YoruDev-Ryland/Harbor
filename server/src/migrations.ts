import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Sqlite = Database.Database;

interface Migration {
  version: number;
  name: string;
  up: (db: Sqlite) => void;
}

function columns(db: Sqlite, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function ensureColumn(db: Sqlite, table: string, name: string, ddl: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function createNotifications(db: Sqlite): void {
  db.exec(`
    CREATE TABLE notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'info',
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT 'general',
      event_key  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at    TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, id);
  `);
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "normalize-legacy-schema",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_groups (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL UNIQUE,
          permissions TEXT NOT NULL DEFAULT '{}',
          is_default  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
          email                 TEXT,
          phone                 TEXT,
          password_hash         TEXT,
          role                  TEXT NOT NULL DEFAULT 'user',
          theme                 TEXT NOT NULL DEFAULT 'dockyard',
          group_id              INTEGER REFERENCES user_groups(id),
          notify_email          INTEGER NOT NULL DEFAULT 0,
          notify_prefs          TEXT NOT NULL DEFAULT '{}',
          download_scope        TEXT NOT NULL DEFAULT 'all',
          request_email         TEXT,
          layout                TEXT NOT NULL DEFAULT '',
          ical_token            TEXT,
          disabled              INTEGER NOT NULL DEFAULT 0,
          session_version       INTEGER NOT NULL DEFAULT 0,
          notifications_seen_at TEXT,
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          last_login            TEXT
        );

        CREATE TABLE IF NOT EXISTS integrations (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL,
          name          TEXT NOT NULL,
          url           TEXT NOT NULL,
          public_url    TEXT NOT NULL DEFAULT '',
          secret        TEXT NOT NULL DEFAULT '',
          enabled       INTEGER NOT NULL DEFAULT 1,
          use_downloads INTEGER NOT NULL DEFAULT 1,
          use_calendar  INTEGER NOT NULL DEFAULT 1,
          use_status    INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS tabs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT NOT NULL,
          url            TEXT NOT NULL,
          local_url      TEXT NOT NULL DEFAULT '',
          icon           TEXT NOT NULL DEFAULT 'globe',
          grp            TEXT NOT NULL DEFAULT '',
          sort           INTEGER NOT NULL DEFAULT 0,
          open_mode      TEXT NOT NULL DEFAULT 'embed',
          ping           INTEGER NOT NULL DEFAULT 1,
          integration_id INTEGER,
          allowed_groups TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS linked_accounts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER NOT NULL,
          provider    TEXT NOT NULL,
          external_id TEXT,
          username    TEXT,
          email       TEXT,
          token_enc   TEXT NOT NULL,
          linked_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS monitors (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          url           TEXT NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          expect_status INTEGER,
          keyword       TEXT,
          sort          INTEGER NOT NULL DEFAULT 0,
          baseline_len  INTEGER,
          last_state    TEXT,
          last_status   INTEGER,
          last_latency  INTEGER,
          last_message  TEXT,
          last_checked  TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS monitor_history (
          monitor_id INTEGER NOT NULL,
          checked_at TEXT NOT NULL DEFAULT (datetime('now')),
          ok         INTEGER NOT NULL,
          status     INTEGER,
          latency    INTEGER
        );

        CREATE TABLE IF NOT EXISTS auth_identities (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          provider   TEXT NOT NULL,
          subject    TEXT NOT NULL,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          display    TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider, subject)
        );

        CREATE TABLE IF NOT EXISTS password_resets (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at INTEGER NOT NULL,
          used_at    TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      ensureColumn(db, "tabs", "local_url", "local_url TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "tabs", "integration_id", "integration_id INTEGER");
      ensureColumn(db, "tabs", "allowed_groups", "allowed_groups TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "integrations", "public_url", "public_url TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "users", "group_id", "group_id INTEGER REFERENCES user_groups(id)");
      ensureColumn(db, "users", "ical_token", "ical_token TEXT");
      ensureColumn(db, "users", "phone", "phone TEXT");
      ensureColumn(db, "users", "notify_email", "notify_email INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "users", "notify_prefs", "notify_prefs TEXT NOT NULL DEFAULT '{}'");
      ensureColumn(db, "users", "notifications_seen_at", "notifications_seen_at TEXT");
      ensureColumn(db, "users", "disabled", "disabled INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "users", "session_version", "session_version INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "users", "layout", "layout TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "users", "download_scope", "download_scope TEXT NOT NULL DEFAULT 'all'");
      ensureColumn(db, "users", "request_email", "request_email TEXT");

      const notificationColumns = columns(db, "notifications");
      if (notificationColumns.size > 0 && !notificationColumns.has("user_id"))
        db.exec("DROP TABLE notifications");
      if (columns(db, "notifications").size === 0) createNotifications(db);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS linked_accounts_user_provider
          ON linked_accounts(user_id, provider);
        CREATE INDEX IF NOT EXISTS monitor_history_mid
          ON monitor_history(monitor_id, checked_at);
        CREATE UNIQUE INDEX IF NOT EXISTS users_ical_token_unique
          ON users(ical_token) WHERE ical_token IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS tabs_integration_id_unique
          ON tabs(integration_id) WHERE integration_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS auth_identities_user ON auth_identities(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_user
          ON auth_identities(provider, user_id);
        CREATE INDEX IF NOT EXISTS password_resets_user
          ON password_resets(user_id, expires_at);
      `);
    },
  },
  {
    version: 2,
    name: "foreign-key-cascades",
    up(db) {
      const notificationColumns = columns(db, "notifications");
      db.exec("DROP INDEX IF EXISTS notifications_user");
      if (notificationColumns.has("user_id")) {
        db.exec("ALTER TABLE notifications RENAME TO notifications_legacy");
        createNotifications(db);
        db.exec(`
          INSERT INTO notifications
            (id, user_id, kind, title, body, category, event_key, created_at, read_at)
          SELECT n.id, n.user_id, n.kind, n.title, n.body, n.category, n.event_key,
                 n.created_at, n.read_at
          FROM notifications_legacy n JOIN users u ON u.id = n.user_id;
          DROP TABLE notifications_legacy;
        `);
      } else {
        db.exec("DROP TABLE IF EXISTS notifications");
        createNotifications(db);
      }

      db.exec(`
        DROP INDEX IF EXISTS monitor_history_mid;
        ALTER TABLE monitor_history RENAME TO monitor_history_legacy;
        CREATE TABLE monitor_history (
          monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
          checked_at TEXT NOT NULL DEFAULT (datetime('now')),
          ok         INTEGER NOT NULL,
          status     INTEGER,
          latency    INTEGER
        );
        INSERT INTO monitor_history (monitor_id, checked_at, ok, status, latency)
          SELECT h.monitor_id, h.checked_at, h.ok, h.status, h.latency
          FROM monitor_history_legacy h JOIN monitors m ON m.id = h.monitor_id;
        DROP TABLE monitor_history_legacy;
        CREATE INDEX monitor_history_mid ON monitor_history(monitor_id, checked_at);

        DROP INDEX IF EXISTS tabs_integration_id_unique;
        ALTER TABLE tabs RENAME TO tabs_legacy;
        CREATE TABLE tabs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT NOT NULL,
          url            TEXT NOT NULL,
          local_url      TEXT NOT NULL DEFAULT '',
          icon           TEXT NOT NULL DEFAULT 'globe',
          grp            TEXT NOT NULL DEFAULT '',
          sort           INTEGER NOT NULL DEFAULT 0,
          open_mode      TEXT NOT NULL DEFAULT 'embed',
          ping           INTEGER NOT NULL DEFAULT 1,
          integration_id INTEGER REFERENCES integrations(id) ON DELETE SET NULL,
          allowed_groups TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO tabs
          (id, name, url, local_url, icon, grp, sort, open_mode, ping, integration_id, allowed_groups)
          SELECT t.id, t.name, t.url, t.local_url, t.icon, t.grp, t.sort, t.open_mode,
                 t.ping,
                 CASE WHEN i.id IS NULL THEN NULL ELSE t.integration_id END,
                 t.allowed_groups
          FROM tabs_legacy t LEFT JOIN integrations i ON i.id = t.integration_id;
        DROP TABLE tabs_legacy;
        CREATE UNIQUE INDEX tabs_integration_id_unique
          ON tabs(integration_id) WHERE integration_id IS NOT NULL;
      `);
    },
  },
  {
    version: 3,
    name: "phase-3-privacy-and-lifecycle",
    up(db) {
      ensureColumn(db, "users", "ical_token_hash", "ical_token_hash TEXT");
      ensureColumn(db, "users", "ical_token_last_used", "ical_token_last_used TEXT");
      const legacyTokens = db
        .prepare(
          "SELECT id, ical_token FROM users WHERE ical_token IS NOT NULL AND ical_token != ''"
        )
        .all() as Array<{ id: number; ical_token: string }>;
      const saveToken = db.prepare(
        "UPDATE users SET ical_token_hash = ?, ical_token = NULL WHERE id = ?"
      );
      for (const row of legacyTokens)
        saveToken.run(createHash("sha256").update(row.ical_token).digest("hex"), row.id);

      // The linked Plex token had no runtime consumer. Purge it instead of
      // retaining a high-value credential that Harbor cannot use safely.
      db.exec("DROP TABLE IF EXISTS linked_accounts");

      db.exec(`
        DROP INDEX IF EXISTS users_ical_token_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS users_ical_token_hash_unique
          ON users(ical_token_hash) WHERE ical_token_hash IS NOT NULL;

        CREATE TABLE IF NOT EXISTS invitations (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          username   TEXT NOT NULL COLLATE NOCASE,
          email      TEXT,
          group_id   INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          used_at    TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS invitations_expiry ON invitations(expires_at, used_at);

        CREATE TABLE IF NOT EXISTS user_push_endpoints (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          enabled    INTEGER NOT NULL DEFAULT 0,
          url        TEXT NOT NULL DEFAULT 'http://ntfy',
          topic      TEXT NOT NULL DEFAULT '',
          token_enc  TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_username TEXT,
          action         TEXT NOT NULL,
          target         TEXT,
          status         INTEGER NOT NULL,
          remote_address TEXT,
          detail_json    TEXT NOT NULL DEFAULT '{}',
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at, id);
        CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_user_id, id);
      `);

      // The legacy shared ntfy broadcast has no consumer after this migration.
      // Purge its credential and routing metadata rather than retaining an
      // obsolete cross-user secret. Users deliberately configure private
      // endpoints after upgrading.
      db.prepare(
        "DELETE FROM settings WHERE key IN ('push_enabled', 'push_url', 'push_topic', 'push_token_enc')"
      ).run();
    },
  },
];

export function runMigrations(db: Sqlite): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version
    )
  );
  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name);
    })();
  }
  return migrations.at(-1)?.version ?? 0;
}

export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
