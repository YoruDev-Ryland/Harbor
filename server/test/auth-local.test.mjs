import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-auth-test-"));
process.env.HARBOR_DATA = dataDir;
process.env.HARBOR_SECRET = "example-local-test-secret-that-is-at-least-32-characters";
process.env.HARBOR_SETUP_TOKEN = "local-setup-token-that-is-at-least-32-chars";
process.env.AUTH_PROXY = "false";

let app;
let db;
let getAdapter;
let adminCookie;

function cookie(response) {
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)?.split(";", 1)[0] ?? "";
}

function inject(method, url, payload, session = adminCookie) {
  return app.inject({
    method,
    url,
    payload,
    headers: session ? { cookie: session } : undefined,
  });
}

before(async () => {
  ({ buildApp: app } = { buildApp: (await import("../dist/app.js")).buildApp });
  ({ db } = await import("../dist/db.js"));
  ({ getAdapter } = await import("../dist/modules/registry.js"));
  app = await app({ logger: false, staticFiles: false });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("setup is token-gated, input-bounded, and one-time", async () => {
  const forged = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { "remote-user": "attacker" },
  });
  assert.equal(forged.json().user, null);
  const bad = await inject(
    "POST",
    "/api/auth/setup",
    { setupToken: "wrong", username: "captain", password: "correct-horse" },
    ""
  );
  assert.equal(bad.statusCode, 403);

  const created = await inject(
    "POST",
    "/api/auth/setup",
    {
      setupToken: process.env.HARBOR_SETUP_TOKEN,
      username: "captain",
      password: "correct-horse",
      email: "captain@example.test",
    },
    ""
  );
  assert.equal(created.statusCode, 200);
  adminCookie = cookie(created);
  assert.ok(adminCookie.startsWith("harbor_session="));

  const reuse = await inject(
    "POST",
    "/api/auth/setup",
    { setupToken: process.env.HARBOR_SETUP_TOKEN, username: "other", password: "correct-horse" },
    ""
  );
  assert.equal(reuse.statusCode, 409);
});

test("password changes require the current credential and rotate sessions", async () => {
  const wrong = await inject("POST", "/api/auth/password", {
    current: "wrong-password",
    password: "example-new-captain-password",
  });
  assert.equal(wrong.statusCode, 403);
  const changed = await inject("POST", "/api/auth/password", {
    current: "correct-horse",
    password: "example-new-captain-password",
  });
  assert.equal(changed.statusCode, 200);
  adminCookie = cookie(changed);
  assert.equal(
    (
      await inject(
        "POST",
        "/api/auth/login",
        { username: "captain", password: "correct-horse" },
        ""
      )
    ).statusCode,
    401
  );
  assert.equal(
    (
      await inject(
        "POST",
        "/api/auth/login",
        { username: "captain", password: "example-new-captain-password" },
        ""
      )
    ).statusCode,
    200
  );
});

test("delegated crew managers cannot take over administrator accounts", async () => {
  const adminGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Administrators'").get();
  const crewGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Crew'").get();
  const managerGroup = await inject("POST", "/api/groups", {
    name: "Crew managers",
    permissions: { viewOverview: true, manageUsers: true },
  });
  assert.equal(managerGroup.statusCode, 200);
  const managerGroupId = managerGroup.json().id;
  const elevatedGroup = await inject("POST", "/api/groups", {
    name: "Integration managers",
    permissions: { viewOverview: true, manageIntegrations: true },
  });
  assert.equal(elevatedGroup.statusCode, 200);

  for (const member of [
    { username: "manager", password: "example-manager-password", group_id: managerGroupId },
    { username: "deckhand", password: "example-deckhand-password", group_id: crewGroup.id },
    { username: "second-admin", password: "example-admin-password", group_id: adminGroup.id },
    {
      username: "integration-lead",
      password: "example-integration-password",
      group_id: elevatedGroup.json().id,
    },
  ]) {
    const response = await inject("POST", "/api/users", member);
    assert.equal(response.statusCode, 200, response.body);
  }

  const managerLogin = await inject(
    "POST",
    "/api/auth/login",
    { username: "manager", password: "example-manager-password" },
    ""
  );
  const managerCookie = cookie(managerLogin);
  const secondAdmin = db.prepare("SELECT id FROM users WHERE username = 'second-admin'").get();
  const deckhand = db.prepare("SELECT id FROM users WHERE username = 'deckhand'").get();
  const manager = db.prepare("SELECT id FROM users WHERE username = 'manager'").get();
  const integrationLead = db
    .prepare("SELECT id FROM users WHERE username = 'integration-lead'")
    .get();

  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/users/${secondAdmin.id}`,
        { email: "owned@example.test" },
        managerCookie
      )
    ).statusCode,
    403
  );
  assert.equal(
    (await inject("DELETE", `/api/users/${secondAdmin.id}`, undefined, managerCookie)).statusCode,
    403
  );
  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/users/${secondAdmin.id}`,
        { group_id: crewGroup.id },
        managerCookie
      )
    ).statusCode,
    403
  );
  assert.equal(
    (await inject("POST", `/api/users/${deckhand.id}/password-reset`, undefined, managerCookie))
      .statusCode,
    403
  );
  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/users/${manager.id}`,
        { group_id: elevatedGroup.json().id },
        managerCookie
      )
    ).statusCode,
    403
  );
  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/users/${deckhand.id}`,
        { email: "must-not-apply@example.test", group_id: elevatedGroup.json().id },
        managerCookie
      )
    ).statusCode,
    403
  );
  assert.equal(db.prepare("SELECT email FROM users WHERE id = ?").get(deckhand.id).email, null);
  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/users/${integrationLead.id}`,
        { email: "changed@example.test" },
        managerCookie
      )
    ).statusCode,
    403
  );
});

test("SSO identity bindings are explicit, admin-only, and hidden from delegated managers", async () => {
  const target = db.prepare("SELECT id FROM users WHERE username = 'integration-lead'").get();
  const managerLogin = await inject(
    "POST",
    "/api/auth/login",
    { username: "manager", password: "example-manager-password" },
    ""
  );
  const managerCookie = cookie(managerLogin);
  assert.equal(
    (
      await inject(
        "POST",
        `/api/users/${target.id}/identities`,
        { provider: "test-oidc", subject: "lead-subject" },
        managerCookie
      )
    ).statusCode,
    403
  );
  const bound = await inject("POST", `/api/users/${target.id}/identities`, {
    provider: "test-oidc",
    subject: "lead-subject",
  });
  assert.equal(bound.statusCode, 200, bound.body);
  const delegatedList = await inject("GET", "/api/users", undefined, managerCookie);
  assert.deepEqual(delegatedList.json().find((user) => user.id === target.id).identities, []);
  assert.equal(
    (await inject("DELETE", `/api/users/${target.id}/identities/${bound.json().id}`)).statusCode,
    200
  );
});

test("disable, reset, session revocation, and last-admin invariants work", async () => {
  const crewGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Crew'").get();
  const deckhand = db.prepare("SELECT id FROM users WHERE username = 'deckhand'").get();
  const captain = db.prepare("SELECT id FROM users WHERE username = 'captain'").get();
  const secondAdmin = db.prepare("SELECT id FROM users WHERE username = 'second-admin'").get();

  const initialLogin = await inject(
    "POST",
    "/api/auth/login",
    { username: "deckhand", password: "example-deckhand-password" },
    ""
  );
  const oldCookie = cookie(initialLogin);
  assert.equal(
    (await inject("PATCH", `/api/users/${deckhand.id}`, { disabled: true })).statusCode,
    200
  );
  assert.equal((await inject("GET", "/api/auth/contact", undefined, oldCookie)).statusCode, 401);
  assert.equal(
    (
      await inject(
        "POST",
        "/api/auth/login",
        { username: "deckhand", password: "example-deckhand-password" },
        ""
      )
    ).statusCode,
    401
  );
  assert.equal(
    (await inject("PATCH", `/api/users/${deckhand.id}`, { disabled: false })).statusCode,
    200
  );

  const reset = await inject("POST", `/api/users/${deckhand.id}/password-reset`);
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().token.length >= 32, true);
  assert.equal((await inject("GET", "/api/auth/contact", undefined, oldCookie)).statusCode, 401);
  const redeemed = await inject(
    "POST",
    "/api/auth/reset",
    { token: reset.json().token, password: "example-new-deckhand-password" },
    ""
  );
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const resetCookie = cookie(redeemed);
  assert.equal(
    (
      await inject(
        "POST",
        "/api/auth/reset",
        { token: reset.json().token, password: "example-another-password" },
        ""
      )
    ).statusCode,
    400
  );
  assert.equal((await inject("POST", `/api/users/${deckhand.id}/logout-all`)).statusCode, 200);
  assert.equal((await inject("GET", "/api/auth/contact", undefined, resetCookie)).statusCode, 401);

  assert.equal((await inject("DELETE", `/api/users/${secondAdmin.id}`)).statusCode, 200);
  assert.equal(
    (
      await inject("PATCH", `/api/users/${captain.id}`, {
        group_id: crewGroup.id,
        email: "must-roll-back@example.test",
      })
    ).statusCode,
    400
  );
  assert.equal(
    db.prepare("SELECT email FROM users WHERE id = ?").get(captain.id).email,
    "captain@example.test"
  );
});

test("route matrix denies hidden modules and configuration inventories", async () => {
  const deckhandLogin = await inject(
    "POST",
    "/api/auth/login",
    { username: "deckhand", password: "example-new-deckhand-password" },
    ""
  );
  const deckhandCookie = cookie(deckhandLogin);
  const adminGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Administrators'").get();
  const hiddenWidgets = [
    "calendar",
    "downloads",
    "stats",
    "nowplaying",
    "recent",
    "system",
    "indexers",
    "containers",
    "continue",
    "storage",
    "sky",
    "sky-heatmap",
    "scope",
    "status",
    "websites",
  ].map((id) => ({ id, allowed_groups: [adminGroup.id] }));
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('widget_layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(hiddenWidgets));

  const hiddenRoutes = [
    ["GET", "/api/widgets/calendar"],
    ["GET", "/api/widgets/calendar/sources"],
    ["GET", "/api/widgets/downloads"],
    ["POST", "/api/widgets/downloads/action", { id: "x", action: "pause" }],
    ["GET", "/api/widgets/nowplaying"],
    ["GET", "/api/widgets/nowplaying/art?source=1&path=x"],
    ["GET", "/api/widgets/system"],
    ["POST", "/api/widgets/plex/resolve", {}],
    ["GET", "/api/widgets/indexers"],
    ["GET", "/api/widgets/containers"],
    ["GET", "/api/widgets/progress"],
    ["GET", "/api/widgets/recent"],
    ["GET", "/api/widgets/storage"],
    ["GET", "/api/widgets/sky"],
    ["GET", "/api/widgets/sky/heatmap"],
    ["GET", "/api/widgets/scope"],
    ["GET", "/api/widgets/scope/image?source=1&index=1"],
    ["GET", "/api/widgets/status"],
    ["GET", "/api/widgets/websites"],
    ["GET", "/api/calendar/subscribe"],
    ["POST", "/api/calendar/rotate"],
  ];
  for (const [method, url, payload] of hiddenRoutes) {
    const response = await inject(method, url, payload, deckhandCookie);
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
  }
  assert.equal(
    (await inject("GET", "/api/integrations", undefined, deckhandCookie)).statusCode,
    403
  );
  assert.equal((await inject("GET", "/api/monitors", undefined, deckhandCookie)).statusCode, 403);
  assert.equal(
    (await inject("GET", "/api/permissions", undefined, deckhandCookie)).statusCode,
    403
  );

  db.prepare(
    "UPDATE users SET ical_token = 'hidden-calendar-token' WHERE username = 'deckhand'"
  ).run();
  assert.equal(
    (await inject("GET", "/api/calendar.ics?token=hidden-calendar-token", undefined, ""))
      .statusCode,
    401
  );

  // Opening one module exposes only sources whose linked berth is visible to
  // this group; internal-only URLs are never returned as browser deep links.
  db.prepare("UPDATE settings SET value = ? WHERE key = 'widget_layout'").run(
    JSON.stringify([{ id: "calendar", allowed_groups: [] }])
  );
  const restricted = db
    .prepare(
      "INSERT INTO integrations (type, name, url, public_url) VALUES ('sonarr', 'Restricted', 'http://secret:8989', 'https://restricted.example.test')"
    )
    .run();
  const open = db
    .prepare(
      "INSERT INTO integrations (type, name, url, public_url) VALUES ('sonarr', 'Open', 'http://internal:8989', 'https://open.example.test')"
    )
    .run();
  db.prepare(
    "INSERT INTO tabs (name, url, integration_id, allowed_groups) VALUES ('Restricted', 'https://restricted.example.test', ?, ?)"
  ).run(restricted.lastInsertRowid, JSON.stringify([adminGroup.id]));
  const sources = await inject("GET", "/api/widgets/calendar/sources", undefined, deckhandCookie);
  assert.equal(sources.statusCode, 200);
  assert.deepEqual(sources.json(), [
    { id: Number(open.lastInsertRowid), url: "https://open.example.test" },
  ]);
});

test("dangerous URL schemes and malformed delivery settings fail with 400", async () => {
  assert.equal(
    (
      await inject("POST", "/api/tabs", {
        name: "Unsafe berth",
        url: "javascript:alert(document.domain)",
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await inject("POST", "/api/integrations", {
        type: "sonarr",
        name: "Unsafe integration",
        url: "file:///etc/passwd",
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await inject("POST", "/api/monitors", {
        name: "Unsafe monitor",
        url: "data:text/html,hello",
      })
    ).statusCode,
    400
  );
  assert.equal(
    (await inject("PATCH", "/api/notifications/push/me", { url: "ftp://example.test" })).statusCode,
    400
  );
  assert.equal((await inject("PATCH", "/api/notifications/smtp", { port: 70000 })).statusCode, 400);
});

test("stored service credentials cannot be retargeted and require explicit secret authority", async () => {
  const smtpFixture = ["smtp", "credential", "fixture"].join("-");
  const pushFixture = ["push", "credential", "fixture"].join("-");
  const created = await inject("POST", "/api/integrations", {
    type: "sonarr",
    name: "Credential target",
    url: "https://one.example.test",
    secrets: { apiKey: "example-write-only-api-key" },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().credentialsComplete, true);
  assert.equal(created.body.includes("example-write-only-api-key"), false);

  const delegatedLogin = await inject(
    "POST",
    "/api/auth/login",
    { username: "integration-lead", password: "example-integration-password" },
    ""
  );
  const delegatedCookie = cookie(delegatedLogin);
  assert.equal(
    (
      await inject(
        "PATCH",
        `/api/integrations/${created.json().id}`,
        { secrets: { apiKey: "example-attempted-replacement" } },
        delegatedCookie
      )
    ).statusCode,
    403
  );

  const moved = await inject("PATCH", `/api/integrations/${created.json().id}`, {
    url: "https://two.example.test",
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().hasSecrets, false);
  assert.equal(moved.json().credentialsComplete, false);

  assert.equal(
    (
      await inject("PATCH", "/api/notifications/smtp", {
        host: "smtp.example.test",
        user: "captain",
        pass: smtpFixture,
      })
    ).statusCode,
    200
  );
  assert.equal((await inject("GET", "/api/notifications/smtp")).json().hasPass, true);
  assert.equal(
    (await inject("PATCH", "/api/notifications/smtp", { host: "other-smtp.example.test" }))
      .statusCode,
    200
  );
  assert.equal((await inject("GET", "/api/notifications/smtp")).json().hasPass, false);

  assert.equal(
    (
      await inject("PATCH", "/api/notifications/push/me", {
        url: "https://push.example.test",
        topic: "harbor",
        token: pushFixture,
      })
    ).statusCode,
    200
  );
  assert.equal((await inject("GET", "/api/notifications/push/me")).json().hasToken, true);
  assert.equal(
    (
      await inject("PATCH", "/api/notifications/push/me", {
        url: "https://other-push.example.test",
      })
    ).statusCode,
    200
  );
  assert.equal((await inject("GET", "/api/notifications/push/me")).json().hasToken, false);
});

test("security headers, origin checks, and malformed structures fail closed", async () => {
  const health = await inject("GET", "/api/health", undefined, "");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.match(health.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(health.headers["cache-control"], "no-store");

  const crossSite = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { origin: "https://attacker.example", cookie: adminCookie },
    payload: {},
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/auth/prefs",
        headers: { cookie: adminCookie },
        payload: [],
      })
    ).statusCode,
    400
  );
  assert.equal(
    (await inject("PATCH", "/api/auth/contact", { email: "ok@example.test", unexpected: true }))
      .statusCode,
    400
  );
  assert.equal((await inject("GET", "/api/widgets/sky?hours=not-a-number")).statusCode, 400);
});

test("same-origin mutations preserve a standalone Host header port", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      host: "127.0.0.1:9090",
      origin: "http://127.0.0.1:9090",
      "content-type": "application/json",
    },
    payload: { username: "missing", password: "example-missing-password" },
  });
  assert.notEqual(response.statusCode, 403, response.body);
  assert.equal(response.statusCode, 401, response.body);
});

test("malformed payload matrix returns bounded 400 responses", async () => {
  const cases = [
    ["PATCH", "/api/auth/prefs", { theme: 42 }],
    ["PATCH", "/api/auth/contact", { notify_prefs: { general: "yes" } }],
    ["POST", "/api/tabs", { name: [], url: {} }],
    ["POST", "/api/monitors", { name: "x", url: "https://example.test", sort: 1.5 }],
    [
      "POST",
      "/api/integrations",
      { type: "sonarr", name: "x", url: "https://example.test", enabled: "yes" },
    ],
    ["PATCH", "/api/notifications/smtp", { host: "bad host" }],
    ["POST", "/api/groups", { name: "bad", permissions: "admin" }],
    [
      "POST",
      "/api/config/import",
      { data: { harbor: "config", version: 2, tabs: "not-an-array" } },
    ],
  ];
  for (let round = 0; round < 4; round += 1) {
    for (const [method, url, payload] of cases) {
      const response = await inject(method, url, payload);
      assert.equal(response.statusCode, 400, `${method} ${url}: ${response.body}`);
      assert.ok(response.body.length < 1_024, `${method} ${url} returned an unbounded error`);
    }
  }
});

test("art proxies reject active/spoofed content and accept matching bounded raster data", async () => {
  const plex = db
    .prepare(
      "INSERT INTO integrations (type, name, url) VALUES ('plex', 'Art source', 'https://plex.example.test')"
    )
    .run();
  const adapter = getAdapter("plex");
  const original = adapter.fetchArt;
  try {
    adapter.fetchArt = async () =>
      new Response("<svg onload=alert(1)></svg>", { headers: { "content-type": "image/svg+xml" } });
    const rejected = await inject(
      "GET",
      `/api/widgets/nowplaying/art?source=${plex.lastInsertRowid}&path=%2Funsafe`
    );
    assert.equal(rejected.statusCode, 415, rejected.body);

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    adapter.fetchArt = async () => new Response(png, { headers: { "content-type": "image/png" } });
    const accepted = await inject(
      "GET",
      `/api/widgets/nowplaying/art?source=${plex.lastInsertRowid}&path=%2Fsafe`
    );
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.headers["content-type"], "image/png");
    assert.equal(accepted.headers["x-content-type-options"], "nosniff");
    assert.match(accepted.headers["content-security-policy"], /sandbox/);
  } finally {
    adapter.fetchArt = original;
  }
});

test("concurrent widget cache misses are coalesced", async () => {
  db.prepare(
    "INSERT INTO integrations (type, name, url) VALUES ('sqm', 'Coalescing SQM', 'https://sqm.example.test')"
  ).run();
  const adapter = getAdapter("sqm");
  const original = adapter.fetchSky;
  let calls = 0;
  try {
    adapter.fetchSky = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    };
    const [one, two, three] = await Promise.all([
      inject("GET", "/api/widgets/sky?hours=13"),
      inject("GET", "/api/widgets/sky?hours=13"),
      inject("GET", "/api/widgets/sky?hours=13"),
    ]);
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(two.statusCode, 200, two.body);
    assert.equal(three.statusCode, 200, three.body);
    assert.equal(calls, 1);
  } finally {
    adapter.fetchSky = original;
  }
});

test("empty SQM years advance a bounded watermark instead of refetching the year", async () => {
  db.prepare("DELETE FROM integrations WHERE type = 'sqm'").run();
  db.prepare(
    "INSERT INTO integrations (type, name, url) VALUES ('sqm', 'Empty SQM', 'https://sqm.example.test')"
  ).run();
  const adapter = getAdapter("sqm");
  const original = adapter.fetchSkyReadings;
  let calls = 0;
  try {
    adapter.fetchSkyReadings = async () => {
      calls += 1;
      return [];
    };
    const year = new Date().getUTCFullYear();
    const first = await inject("GET", `/api/widgets/sky/heatmap?year=${year}`);
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(calls > 1 && calls < 35, `expected a bounded year backfill, got ${calls} calls`);
    const afterBackfill = calls;

    const deckhandLogin = await inject(
      "POST",
      "/api/auth/login",
      { username: "deckhand", password: "example-new-deckhand-password" },
      ""
    );
    const secondScope = await inject(
      "GET",
      `/api/widgets/sky/heatmap?year=${year}`,
      undefined,
      cookie(deckhandLogin)
    );
    assert.equal(secondScope.statusCode, 200, secondScope.body);
    assert.equal(calls, afterBackfill, "empty range was fetched again for another cache scope");
  } finally {
    adapter.fetchSkyReadings = original;
  }
});

test("dense SQM years continue after a response-sized page", async () => {
  db.prepare("DELETE FROM integrations WHERE type = 'sqm'").run();
  db.prepare(
    "INSERT INTO integrations (type, name, url) VALUES ('sqm', 'Dense SQM', 'https://sqm.example.test')"
  ).run();
  const adapter = getAdapter("sqm");
  const original = adapter.fetchSkyReadings;
  const historicalCalls = [];
  let sentFullPage = false;
  let sentContinuation = false;
  try {
    adapter.fetchSkyReadings = async (_cfg, sinceSec, _untilSec, limit) => {
      if (limit === 1) return [{ ts: sinceSec + 1, mpsas: 20 }];
      historicalCalls.push({ sinceSec, limit });
      if (!sentFullPage) {
        sentFullPage = true;
        return Array.from({ length: limit }, (_, index) => ({
          ts: sinceSec + index + 1,
          mpsas: 10,
        }));
      }
      if (!sentContinuation) {
        sentContinuation = true;
        return [{ ts: sinceSec + 1800, mpsas: 21.5 }];
      }
      return [];
    };

    const year = new Date().getUTCFullYear() - 2;
    const response = await inject("GET", `/api/widgets/sky/heatmap?year=${year}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(historicalCalls[0].limit, 10_000);
    assert.ok(
      historicalCalls[1].sinceSec < historicalCalls[0].sinceSec + 14 * 86_400,
      "the next request skipped to the following time chunk"
    );
    assert.ok(
      response.json().buckets.some((bucket) => bucket.v === 21.5),
      "the continuation page was not included in the heatmap"
    );
  } finally {
    adapter.fetchSkyReadings = original;
  }
});

test("client login rate limiting returns Retry-After", async () => {
  let limited;
  for (let i = 0; i < 35; i += 1) {
    const response = await inject(
      "POST",
      "/api/auth/login",
      { username: `missing-${i}`, password: "wrong-password" },
      ""
    );
    if (response.statusCode === 429) {
      limited = response;
      break;
    }
  }
  assert.ok(limited, "expected client-wide login limiter to trigger");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
});
