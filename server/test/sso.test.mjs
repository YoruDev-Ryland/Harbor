import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-sso-test-"));
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-sso-test-secret-that-is-at-least-32-characters";
process.env.AUTH_PROXY = "true";
process.env.AUTH_PROXY_PROVIDER = "test-oidc";
process.env.AUTH_PROXY_HEADERS = "Remote-User";
process.env.AUTH_PROXY_TRUSTED = "127.0.0.1/32";
process.env.ADMIN_USERS = "alice";
process.env.PUBLIC_URL = "https://harbor.example.test";

let app;
let db;

before(async () => {
  const modules = await Promise.all([import("../dist/app.js"), import("../dist/db.js")]);
  app = await modules[0].buildApp({ logger: false, staticFiles: false });
  db = modules[1].db;
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function sso(identity, remoteAddress = "127.0.0.1") {
  return app.inject({
    method: "GET",
    url: "/api/auth/me",
    remoteAddress,
    headers: { "remote-user": identity },
  });
}

test("trusted SSO uses stable provider-subject bindings", async () => {
  const first = await sso("Alice");
  assert.equal(first.statusCode, 200, first.body);
  const firstUser = first.json().user;
  assert.equal(firstUser.username, "alice");
  assert.equal(firstUser.role, "admin");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider = 'test-oidc'").get().n,
    1
  );

  db.prepare(
    "UPDATE users SET username = 'alice-renamed', email = 'changed@example.test' WHERE id = ?"
  ).run(firstUser.id);
  const again = await sso("alice");
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().user.id, firstUser.id);
  assert.equal(again.json().user.username, "alice-renamed");
});

test("email collisions do not claim local accounts", async () => {
  const crew = db.prepare("SELECT id FROM user_groups WHERE name = 'Crew'").get();
  db.prepare(
    "INSERT INTO users (username, email, group_id) VALUES ('local-bob', 'charlie', ?)"
  ).run(crew.id);
  const response = await sso("charlie");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.username, "charlie");
  assert.notEqual(response.json().user.username, "local-bob");
});

test("a username with a different provider binding fails closed", async () => {
  const crew = db.prepare("SELECT id FROM user_groups WHERE name = 'Crew'").get();
  const dave = db.prepare("INSERT INTO users (username, group_id) VALUES ('dave', ?)").run(crew.id);
  db.prepare(
    "INSERT INTO auth_identities (provider, subject, user_id) VALUES ('test-oidc', 'old-dave-subject', ?)"
  ).run(dave.lastInsertRowid);
  const conflict = await sso("dave");
  assert.equal(conflict.statusCode, 403);
});

test("an unbound SSO subject cannot claim a local password account", async () => {
  const crew = db.prepare("SELECT id FROM user_groups WHERE name = 'Crew'").get();
  db.prepare(
    "INSERT INTO users (username, password_hash, group_id) VALUES ('local-erin', 'local-hash-marker', ?)"
  ).run(crew.id);
  const conflict = await sso("local-erin");
  assert.equal(conflict.statusCode, 403);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE subject = 'local-erin'").get().n,
    0
  );
});

test("untrusted peers cannot assert identity and disabled SSO accounts are rejected", async () => {
  const spoof = await sso("mallory", "203.0.113.10");
  assert.equal(spoof.statusCode, 200);
  assert.equal(spoof.json().user, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'mallory'").get().n, 0);

  const alice = db.prepare("SELECT id FROM users WHERE username = 'alice-renamed'").get();
  db.prepare(
    "UPDATE users SET disabled = 1, session_version = session_version + 1 WHERE id = ?"
  ).run(alice.id);
  const disabled = await sso("alice");
  assert.equal(disabled.statusCode, 403);
});
