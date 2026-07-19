import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-migration-test-"));
const dbPath = path.join(dataDir, "harbor.db");
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    email TEXT, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user',
    theme TEXT NOT NULL DEFAULT 'dockyard', created_at TEXT DEFAULT (datetime('now')), last_login TEXT
  );
  CREATE TABLE user_groups (id INTEGER PRIMARY KEY, name TEXT UNIQUE, permissions TEXT DEFAULT '{}', is_default INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE integrations (id INTEGER PRIMARY KEY, type TEXT, name TEXT, url TEXT, secret TEXT DEFAULT '', enabled INTEGER DEFAULT 1, use_downloads INTEGER DEFAULT 1, use_calendar INTEGER DEFAULT 1, use_status INTEGER DEFAULT 1);
  CREATE TABLE tabs (id INTEGER PRIMARY KEY, name TEXT, url TEXT, icon TEXT DEFAULT 'globe', grp TEXT DEFAULT '', sort INTEGER DEFAULT 0, open_mode TEXT DEFAULT 'embed', ping INTEGER DEFAULT 1);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, provider TEXT, token_enc TEXT, linked_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE monitors (id INTEGER PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, expect_status INTEGER, keyword TEXT, sort INTEGER DEFAULT 0, baseline_len INTEGER, last_state TEXT, last_status INTEGER, last_latency INTEGER, last_message TEXT, last_checked TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE monitor_history (monitor_id INTEGER, checked_at TEXT DEFAULT (datetime('now')), ok INTEGER, status INTEGER, latency INTEGER);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, kind TEXT, title TEXT, body TEXT, created_at TEXT);
  INSERT INTO users (id, username, role) VALUES (1, 'legacy-admin', 'admin');
  INSERT INTO user_groups (id, name, permissions, is_default) VALUES (1, 'Administrators', '{"admin":true}', 0), (2, 'Crew', '{"viewOverview":true}', 1);
  INSERT INTO linked_accounts (id, user_id, provider, token_enc) VALUES (1, 1, 'plex', 'legacy-sensitive-token');
  INSERT INTO settings (key, value) VALUES
    ('push_enabled', '1'),
    ('push_url', 'https://push.example.test'),
    ('push_topic', 'shared-topic'),
    ('push_token_enc', 'legacy-shared-push-token');
  INSERT INTO monitors (id, name, url) VALUES (1, 'Legacy monitor', 'https://legacy.example.test');
  INSERT INTO monitor_history (monitor_id, ok, status, latency) VALUES (1, 1, 200, 10);
`);
legacy.close();
fs.chmodSync(dbPath, 0o644);

process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-migration-secret-that-is-at-least-32-characters";
process.env.AUTH_PROXY = "false";

const { db, schemaVersion } = await import("../dist/db.js");

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("legacy pre-ledger schema upgrades transactionally without retaining orphan credentials", () => {
  assert.equal(schemaVersion, 3);
  assert.equal(db.prepare("SELECT group_id FROM users WHERE id = 1").get().group_id, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM monitor_history WHERE monitor_id = 1").get().count,
    1
  );
  assert.equal(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linked_accounts'")
      .get(),
    undefined
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'push_%'").get().count,
    0
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.prepare("DELETE FROM monitors WHERE id = 1").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM monitor_history WHERE monitor_id = 1").get().count,
    0
  );
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});
