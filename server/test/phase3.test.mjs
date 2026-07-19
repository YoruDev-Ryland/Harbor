import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-phase3-test-"));
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-phase-three-secret-that-is-at-least-32-characters";
process.env.HARBOR_SETUP_TOKEN = "phase-three-setup-token-that-is-at-least-32-chars";
process.env.AUTH_PROXY = "false";

let app;
let db;
let adminCookie = "";
let schemaVersion;

function cookie(response) {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value[0] : value)?.split(";", 1)[0] ?? "";
}
function inject(method, url, payload, session = adminCookie) {
  return app.inject({ method, url, payload, headers: session ? { cookie: session } : undefined });
}

before(async () => {
  const appModule = await import("../dist/app.js");
  const dbModule = await import("../dist/db.js");
  app = await appModule.buildApp({ logger: false, staticFiles: false });
  db = dbModule.db;
  schemaVersion = dbModule.schemaVersion;
  const setup = await inject(
    "POST",
    "/api/auth/setup",
    {
      setupToken: process.env.HARBOR_SETUP_TOKEN,
      username: "captain",
      password: "example-captain-password",
      email: "captain@example.test",
    },
    ""
  );
  assert.equal(setup.statusCode, 200, setup.body);
  adminCookie = cookie(setup);
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fresh schema is versioned, ready, referentially valid, and private on disk", async () => {
  assert.equal(schemaVersion, 3);
  assert.deepEqual(
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version),
    [1, 2, 3]
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const ready = await inject("GET", "/api/health/ready", undefined, "");
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().schemaVersion, 3);
  assert.equal(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linked_accounts'")
      .get(),
    undefined
  );
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  for (const name of ["harbor.db", "harbor.db-wal", "harbor.db-shm"])
    if (fs.existsSync(path.join(dataDir, name)))
      assert.equal(fs.statSync(path.join(dataDir, name)).mode & 0o777, 0o600);
});

test("one-time invitations activate an account without storing the bearer token", async () => {
  const group = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
  const issued = await inject("POST", "/api/users/invites", {
    username: "invited-sailor",
    email: "sailor@example.test",
    group_id: group.id,
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const invite = issued.json();
  const stored = db.prepare("SELECT token_hash FROM invitations WHERE id = ?").get(invite.id);
  assert.notEqual(stored.token_hash, invite.token);
  assert.equal(JSON.stringify(stored).includes(invite.token), false);

  const accepted = await inject(
    "POST",
    "/api/auth/invite",
    { token: invite.token, password: "example-invited-password" },
    ""
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok(cookie(accepted).startsWith("harbor_session="));
  const reused = await inject(
    "POST",
    "/api/auth/invite",
    { token: invite.token, password: "example-another-password" },
    ""
  );
  assert.equal(reused.statusCode, 400);
});

test("calendar subscription bearers are shown once, hashed at rest, revocable, and last-used", async () => {
  const created = await inject("POST", "/api/calendar/subscribe");
  assert.equal(created.statusCode, 200, created.body);
  const first = created.json().token;
  const row = db
    .prepare("SELECT ical_token, ical_token_hash FROM users WHERE username = 'captain'")
    .get();
  assert.equal(row.ical_token, null);
  assert.notEqual(row.ical_token_hash, first);
  assert.equal(
    (await inject("GET", `/api/calendar.ics?token=${encodeURIComponent(first)}`, undefined, ""))
      .statusCode,
    200
  );
  assert.ok(
    db.prepare("SELECT ical_token_last_used FROM users WHERE username = 'captain'").get()
      .ical_token_last_used
  );
  const status = await inject("GET", "/api/calendar/subscribe");
  assert.deepEqual(Object.keys(status.json()).sort(), ["active", "lastUsed"]);
  const rotated = await inject("POST", "/api/calendar/rotate");
  assert.equal(rotated.statusCode, 200);
  assert.equal(
    (await inject("GET", `/api/calendar.ics?token=${encodeURIComponent(first)}`, undefined, ""))
      .statusCode,
    401
  );
});

test("deleting a user cascades every user-owned credential and activity row", async () => {
  const group = db.prepare("SELECT id FROM user_groups WHERE is_default = 1").get();
  const created = await inject("POST", "/api/users", {
    username: "temporary-user",
    password: "example-temporary-password",
    group_id: group.id,
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  db.prepare("INSERT INTO notifications (user_id, title) VALUES (?, 'owned')").run(id);
  db.prepare(
    "INSERT INTO user_push_endpoints (user_id, enabled, url, topic) VALUES (?, 1, 'https://push.example.test', 'private')"
  ).run(id);
  db.prepare(
    "INSERT INTO auth_identities (provider, subject, user_id) VALUES ('proxy', 'temporary-subject', ?)"
  ).run(id);
  db.prepare(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, 'temporary-reset-hash', ?)"
  ).run(id, Date.now() + 60_000);
  db.prepare(
    "INSERT INTO audit_log (actor_user_id, actor_username, action, status, remote_address) VALUES (?, 'temporary-user', 'fixture', 200, '192.0.2.10')"
  ).run(id);
  assert.equal((await inject("DELETE", `/api/users/${id}`)).statusCode, 200);
  for (const [table, column] of [
    ["notifications", "user_id"],
    ["user_push_endpoints", "user_id"],
    ["auth_identities", "user_id"],
    ["password_resets", "user_id"],
  ])
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id).count,
      0
    );
  const retainedAudit = db
    .prepare(
      "SELECT actor_user_id, actor_username, remote_address FROM audit_log WHERE action = 'fixture'"
    )
    .get();
  assert.deepEqual(retainedAudit, {
    actor_user_id: null,
    actor_username: "deleted-user",
    remote_address: null,
  });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("notification eligibility is shared by feed and private delivery channels", async () => {
  const group = db
    .prepare("INSERT INTO user_groups (name, permissions) VALUES ('No overview', '{}')")
    .run();
  const hidden = db
    .prepare("INSERT INTO users (username, role, group_id) VALUES ('hidden-user', 'user', ?)")
    .run(group.lastInsertRowid);
  const { notify } = await import("../dist/lib/notify.js");
  await notify({
    kind: "success",
    category: "downloads",
    title: "Private delivery fixture",
    body: "visibility test",
    eventKey: "phase3:private-delivery",
  });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND title = 'Private delivery fixture'"
      )
      .get(hidden.lastInsertRowid).count,
    0
  );
  assert.ok(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM notifications WHERE title = 'Private delivery fixture'"
      )
      .get().count >= 1
  );
});

test("sensitive backup round-trips every durable section and fails closed on key mismatch", async () => {
  const monitor = db
    .prepare(
      "INSERT INTO monitors (name, url) VALUES ('Backup monitor', 'https://monitor.example.test')"
    )
    .run();
  db.prepare(
    "INSERT INTO monitor_history (monitor_id, ok, status, latency) VALUES (?, 1, 200, 42)"
  ).run(monitor.lastInsertRowid);
  db.prepare(
    "INSERT INTO notifications (user_id, title, body) SELECT id, 'Backup event', 'preserve me' FROM users WHERE username = 'captain'"
  ).run();
  assert.equal(
    (
      await inject("PATCH", "/api/notifications/push/me", {
        enabled: true,
        url: "https://push.example.test",
        topic: "captain",
        token: "private-push-token-fixture",
      })
    ).statusCode,
    200
  );
  const exported = await inject("GET", "/api/config/export");
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(exported.headers["content-disposition"], /sensitive-backup/);
  assert.equal(exported.headers["cache-control"], "no-store");
  const backup = exported.json();
  assert.equal(backup.harbor, "backup");
  assert.equal(backup.version, 3);
  for (const key of [
    "users",
    "auth_identities",
    "monitors",
    "monitor_history",
    "notifications",
    "user_push_endpoints",
    "audit_log",
  ])
    assert.ok(Array.isArray(backup[key]), key);

  const mismatch = structuredClone(backup);
  mismatch.keyFingerprint = "different-master-key";
  assert.equal((await inject("POST", "/api/config/import", { data: mismatch })).statusCode, 400);

  const broken = structuredClone(backup);
  broken.notifications[0].user_id = 999_999;
  const userCountBefore = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  assert.equal((await inject("POST", "/api/config/import", { data: broken })).statusCode, 400);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    userCountBefore,
    "failed restore did not roll back"
  );

  db.prepare("DELETE FROM monitors WHERE id = ?").run(monitor.lastInsertRowid);
  db.prepare("UPDATE settings SET value = 'Mutated' WHERE key = 'title'").run();
  const restored = await inject("POST", "/api/config/import", { data: backup });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM monitors WHERE name = 'Backup monitor'").get().count,
    1
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM monitor_history WHERE status = 200 AND latency = 42")
      .get().count,
    1
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE title = 'Backup event'").get()
      .count,
    1
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM user_push_endpoints WHERE topic = 'captain'").get()
      .count,
    1
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("audit records bounded route metadata without request secrets", async () => {
  const secretPassword = "never-record-this-password";
  const failed = await inject(
    "POST",
    "/api/auth/login",
    { username: "missing-user", password: secretPassword },
    ""
  );
  assert.equal(failed.statusCode, 401);
  const row = db
    .prepare(
      "SELECT * FROM audit_log WHERE action = 'POST /api/auth/login' ORDER BY id DESC LIMIT 1"
    )
    .get();
  assert.equal(row.status, 401);
  assert.equal(row.actor_username, "missing-user");
  assert.equal(JSON.stringify(row).includes(secretPassword), false);
});

test("email envelopes isolate and deduplicate recipients and logs redact bearer queries", async () => {
  const { isolatedRecipients } = await import("../dist/lib/mailer.js");
  const { redactSensitiveUrl } = await import("../dist/lib/logging.js");
  assert.deepEqual(
    isolatedRecipients(["Alice@Example.test", "alice@example.test", "bob@example.test"]),
    ["alice@example.test", "bob@example.test"]
  );
  const redacted = redactSensitiveUrl("/api/calendar.ics?token=secret-calendar-token&view=month");
  assert.equal(redacted.includes("secret-calendar-token"), false);
  assert.match(redacted, /REDACTED/);
});
