import assert from "node:assert/strict";
import { test } from "node:test";

const { formatFinishedDownload } = await import("../dist/lib/downloadNotification.js");
const { plexRecentFields } = await import("../dist/modules/adapters/plex.js");
const { tautulliRecentFields } = await import("../dist/modules/adapters/tautulli.js");
const { ninaActivitySamples } = await import("../dist/modules/adapters/nina.js");

test("finished-download notifications lead with media identity", () => {
  assert.deepEqual(
    formatFinishedDownload({
      title: "White Album",
      episode: "S02E07",
      subtitle: "Hand to hand, shoulder to shoulder, back to back, and then",
      client: "SABnzbd",
    }),
    {
      title: "White Album · S02E07",
      body: "Hand to hand, shoulder to shoulder, back to back, and then · Download finished · SABnzbd",
    }
  );
});

test("Plex and Tautulli season rows use the series as the poster headline", () => {
  assert.deepEqual(
    plexRecentFields({
      type: "season",
      title: "Season 2",
      parentTitle: "Resident Alien",
      parentThumb: "/library/metadata/1/thumb/2",
      ratingKey: 22,
    }),
    {
      kind: "show",
      title: "Resident Alien",
      subtitle: "Season 2",
      artPath: "/library/metadata/1/thumb/2",
      ratingKey: "22",
      addedAt: undefined,
    }
  );
  assert.equal(
    tautulliRecentFields({
      media_type: "season",
      title: "Season 1",
      parent_title: "Dr. Stone",
      parent_thumb: "/library/metadata/3/thumb/4",
      rating_key: "33",
    }).title,
    "Dr. Stone"
  );
});

test("NINA history creates exposure, target, and meridian events with stable details", () => {
  const events = ninaActivitySamples([
    {
      Id: 1,
      Date: "2026-07-19T22:00:00Z",
      ExposureTime: 60,
      Filter: "H",
      TargetName: "M27",
      SideOfPier: "East",
      ImageType: "Light",
    },
    {
      Id: 2,
      Date: "2026-07-19T22:02:00Z",
      ExposureTime: 120,
      Filter: "OIII",
      TargetName: "NGC 7000",
      SideOfPier: "West",
      ImageType: "Light",
    },
  ]);
  assert.equal(events.filter((event) => event.kind === "exposure").length, 2);
  assert.deepEqual(
    events.filter((event) => event.kind === "target").map((event) => event.detail),
    ["M27", "NGC 7000"]
  );
  assert.equal(events.find((event) => event.kind === "meridian")?.title, "Meridian flip completed");
  assert.match(events.at(-1).detail, /2m · OIII · NGC 7000 · Light/);
});
