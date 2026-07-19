import assert from "node:assert/strict";
import { test } from "node:test";

process.env.HARBOR_DATA = process.env.HARBOR_DATA || "/tmp/harbor-adapter-contract";
process.env.HARBOR_SECRET = "example-adapter-contract-secret-at-least-32-characters";
process.env.AUTH_PROXY = "false";

const { adapterCatalog, getAdapter } = await import("../dist/modules/registry.js");

const EXPECTED_TYPES = [
  "audiobookshelf",
  "beszel",
  "jellyseerr",
  "kavita",
  "lidarr",
  "nina",
  "nzbget",
  "plex",
  "portainer",
  "prowlarr",
  "qbittorrent",
  "radarr",
  "readarr",
  "sabnzbd",
  "sonarr",
  "sqm",
  "tautulli",
  "transmission",
];

const CAPABILITY_METHOD = {
  queue: "fetchQueue",
  calendar: "fetchCalendar",
  nowPlaying: "fetchNowPlaying",
  system: "fetchSystems",
  indexers: "fetchIndexers",
  containers: "fetchContainers",
  progress: "fetchProgress",
  recentlyAdded: "fetchRecentlyAdded",
  storage: "fetchStorage",
  sky: "fetchSky",
  scope: "fetchScope",
};

test("adapter catalog metadata is unique, bounded, and safe for the public API", () => {
  const catalog = adapterCatalog();
  assert.deepEqual(catalog.map((adapter) => adapter.type).sort(), EXPECTED_TYPES);
  assert.equal(new Set(catalog.map((adapter) => adapter.label)).size, catalog.length);
  for (const meta of catalog) {
    assert.match(meta.type, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(meta.label.length > 0 && meta.label.length <= 64);
    assert.ok(
      meta.category && meta.category !== "Other",
      `${meta.type} needs an explicit category`
    );
    const placeholder = new URL(meta.urlPlaceholder);
    assert.ok(["http:", "https:"].includes(placeholder.protocol));
    assert.equal(placeholder.username, "");
    assert.equal(placeholder.password, "");
    assert.equal(new Set(meta.capabilities).size, meta.capabilities.length);
    assert.equal(new Set(meta.fields.map((field) => field.key)).size, meta.fields.length);
    for (const field of meta.fields) {
      assert.match(field.key, /^[a-z][A-Za-z0-9]{0,31}$/);
      assert.ok(["text", "password", "url"].includes(field.type));
      assert.ok(field.label.length > 0 && field.label.length <= 96);
    }
    assert.doesNotThrow(() => JSON.stringify(meta));
  }
});

test("adapter capabilities match their implemented runtime methods", () => {
  for (const meta of adapterCatalog()) {
    const adapter = getAdapter(meta.type);
    assert.ok(adapter, meta.type);
    assert.equal(typeof adapter.test, "function", `${meta.type} must implement test()`);
    for (const [capability, method] of Object.entries(CAPABILITY_METHOD)) {
      if (meta.capabilities.includes(capability))
        assert.equal(typeof adapter[method], "function", `${meta.type}.${method}`);
    }
    if (adapter.queueActions?.length) {
      assert.ok(meta.capabilities.includes("queue"));
      assert.equal(typeof adapter.runQueueAction, "function");
      assert.equal(new Set(adapter.queueActions).size, adapter.queueActions.length);
    }
  }
  assert.equal(getAdapter("unknown-adapter"), undefined);
});
