import type {
  CalendarEvent,
  CalendarOpts,
  DownloadItem,
  DownloadState,
  IntegrationAdapter,
  IntegrationConfig,
  QueueAction,
  ReleaseState,
  StorageMount,
} from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

/** The *arrs delegate to a download client, so the only queue action they own
 *  is removing an item (optionally from the client). We never delete data. */
async function arrRemove(cfg: IntegrationConfig, apiVersion: string, id: string): Promise<void> {
  const res = await fetchRaw(
    joinUrl(cfg.url, `/api/${apiVersion}/queue/${id}?removeFromClient=true&blocklist=false`),
    { method: "DELETE", headers: headers(cfg) }
  );
  if (!res.ok) throw new Error(`${cfg.type} HTTP ${res.status}`);
}

const ARR_REMOVE_ONLY: QueueAction[] = ["remove"];

/** date-only (YYYY-MM-DD) calendar params avoid timezone edge bugs in the *arrs */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Shared adapter for the *arr family (Sonarr, Radarr — Lidarr etc. can be
 * added the same way). Uses their v3 HTTP API with an X-Api-Key header.
 */

function headers(cfg: IntegrationConfig): Record<string, string> {
  return { "X-Api-Key": cfg.secrets.apiKey ?? "" };
}

function parseTimeleft(t?: string): number | undefined {
  if (!t) return undefined;
  // "12:34:56" or "1.12:34:56" / "1:12:34:56" (days)
  const parts = t.replace(".", ":").split(":").map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * (parts.length === 4 ? 24 / 60 : 1);
}

function mapQueueState(rec: any): DownloadState {
  if (rec.trackedDownloadState === "importing" || rec.trackedDownloadState === "importPending")
    return "importing";
  if (rec.trackedDownloadStatus === "error" || rec.status === "failed" || rec.errorMessage)
    return "error";
  switch (rec.status) {
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "queued":
    case "delay":
      return "queued";
    default:
      return "downloading";
  }
}

function idsOf(rec: any): DownloadItem["externalIds"] {
  const media = rec.series ?? rec.movie;
  if (!media) return undefined;
  const ids = {
    imdb: media.imdbId || undefined,
    tvdb: media.tvdbId || undefined,
    tmdb: media.tmdbId || undefined,
  };
  return ids.imdb || ids.tvdb || ids.tmdb ? ids : undefined;
}

async function fetchArrQueue(
  cfg: IntegrationConfig,
  apiVersion: string,
  includeParams: string,
  titleOf: (rec: any) => string,
  metaOf?: (rec: any) => { episode?: string; subtitle?: string }
): Promise<DownloadItem[]> {
  const data = await fetchJson<any>(
    joinUrl(cfg.url, `/api/${apiVersion}/queue?page=1&pageSize=100${includeParams}`),
    { headers: headers(cfg) }
  );
  const records: any[] = data.records ?? [];
  return records.map((rec) => {
    const size = Number(rec.size) || 0;
    const left = Number(rec.sizeleft) || 0;
    const meta = metaOf?.(rec) ?? {};
    return {
      id: `${cfg.type}-${cfg.id}-${rec.id}`,
      source: { id: cfg.id, type: cfg.type, name: cfg.name },
      title: titleOf(rec),
      episode: meta.episode,
      subtitle: meta.subtitle,
      state: mapQueueState(rec),
      progress: size > 0 ? Math.min(1, (size - left) / size) : 0,
      sizeBytes: size,
      sizeLeftBytes: left,
      etaSeconds: parseTimeleft(rec.timeleft),
      category: rec.downloadClient,
      errorMessage: rec.errorMessage || undefined,
      externalIds: idsOf(rec),
    };
  });
}

/** Every *arr exposes /api/{v}/diskspace with real free/total bytes per mount. */
async function fetchArrStorage(
  cfg: IntegrationConfig,
  apiVersion: string
): Promise<StorageMount[]> {
  const rows = await fetchJson<any[]>(joinUrl(cfg.url, `/api/${apiVersion}/diskspace`), {
    headers: headers(cfg),
  });
  return (rows ?? [])
    .map((d): StorageMount | null => {
      const total = Number(d.totalSpace) || 0;
      const free = Number(d.freeSpace) || 0;
      if (total <= 0) return null;
      return {
        id: `${cfg.type}-${cfg.id}-${d.path}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        label: d.label || d.path || "mount",
        path: d.path || undefined,
        usedPct: Math.round(((total - free) / total) * 1000) / 10,
        freeBytes: free,
        totalBytes: total,
      };
    })
    .filter((m): m is StorageMount => m !== null);
}

export const sonarr: IntegrationAdapter = {
  type: "sonarr",
  label: "Sonarr",
  urlPlaceholder: "http://sonarr:8989",
  capabilities: ["queue", "calendar", "status", "storage"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const status = await fetchJson<any>(joinUrl(cfg.url, "/api/v3/system/status"), {
      headers: headers(cfg),
    });
    return { ok: true, latencyMs: Date.now() - t0, version: status.version };
  },

  queueActions: ARR_REMOVE_ONLY,
  runQueueAction: (cfg, id, action) =>
    action === "remove" ? arrRemove(cfg, "v3", id) : Promise.resolve(),

  fetchStorage: (cfg) => fetchArrStorage(cfg, "v3"),

  async fetchQueue(cfg) {
    // includeEpisode surfaces the season/episode + episode title for each grab
    return fetchArrQueue(
      cfg,
      "v3",
      "&includeSeries=true&includeMovie=true&includeEpisode=true",
      (rec) => rec.series?.title ?? rec.title ?? "Unknown",
      (rec) => {
        const ep = rec.episode;
        if (!ep || ep.seasonNumber == null || ep.episodeNumber == null) return {};
        return {
          episode: `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
          subtitle: ep.title || undefined,
        };
      }
    );
  },

  async fetchCalendar(cfg, startIso, endIso, opts?: CalendarOpts) {
    const eps = await fetchJson<any[]>(
      joinUrl(
        cfg.url,
        `/api/v3/calendar?start=${dateOnly(startIso)}&end=${dateOnly(endIso)}` +
          `&includeSeries=true&unmonitored=${opts?.unmonitored ? "true" : "false"}`
      ),
      { headers: headers(cfg) }
    );
    const now = Date.now();
    return eps.map((ep): CalendarEvent => {
      let state: ReleaseState = "missing";
      if (ep.hasFile) state = "downloaded";
      else if (ep.grabbed) state = "downloading";
      else if (new Date(ep.airDateUtc).getTime() > now) state = "unaired";
      return {
        id: `sonarr-${cfg.id}-${ep.id}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: ep.series?.title ?? "Unknown series",
        subtitle: ep.title,
        episode: `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
        airDateUtc: ep.airDateUtc,
        state,
        kind: "episode",
        isAnime: ep.series?.seriesType === "anime" || undefined,
        externalIds: {
          imdb: ep.series?.imdbId || undefined,
          tvdb: ep.series?.tvdbId || undefined,
          tmdb: ep.series?.tmdbId || undefined,
          slug: ep.series?.titleSlug || undefined,
        },
      };
    });
  },
};

export const radarr: IntegrationAdapter = {
  type: "radarr",
  label: "Radarr",
  urlPlaceholder: "http://radarr:7878",
  capabilities: ["queue", "calendar", "status", "storage"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const status = await fetchJson<any>(joinUrl(cfg.url, "/api/v3/system/status"), {
      headers: headers(cfg),
    });
    return { ok: true, latencyMs: Date.now() - t0, version: status.version };
  },

  queueActions: ARR_REMOVE_ONLY,
  runQueueAction: (cfg, id, action) =>
    action === "remove" ? arrRemove(cfg, "v3", id) : Promise.resolve(),

  fetchStorage: (cfg) => fetchArrStorage(cfg, "v3"),

  async fetchQueue(cfg) {
    return fetchArrQueue(
      cfg,
      "v3",
      "&includeMovie=true",
      (rec) => rec.movie?.title ?? rec.title ?? "Unknown"
    );
  },

  async fetchCalendar(cfg, startIso, endIso, opts?: CalendarOpts) {
    const movies = await fetchJson<any[]>(
      joinUrl(
        cfg.url,
        `/api/v3/calendar?start=${dateOnly(startIso)}&end=${dateOnly(endIso)}` +
          `&unmonitored=${opts?.unmonitored ? "true" : "false"}`
      ),
      { headers: headers(cfg) }
    );
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    const now = Date.now();
    const events: CalendarEvent[] = [];
    for (const m of movies) {
      const releases: Array<[string, string | undefined]> = [
        ["In cinemas", m.inCinemas],
        ["Digital release", m.digitalRelease],
        ["Physical release", m.physicalRelease],
      ];
      for (const [releaseKind, date] of releases) {
        if (!date) continue;
        const t = new Date(date).getTime();
        if (t < start || t > end) continue;
        let state: ReleaseState = "missing";
        if (m.hasFile) state = "downloaded";
        else if (t > now) state = "unaired";
        events.push({
          id: `radarr-${cfg.id}-${m.id}-${releaseKind}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          title: m.title,
          subtitle: releaseKind,
          airDateUtc: date,
          allDay: true,
          state,
          kind: "movie",
          externalIds: {
            imdb: m.imdbId || undefined,
            tmdb: m.tmdbId || undefined,
            slug: m.titleSlug || undefined,
          },
        });
      }
    }
    return events;
  },
};

// ── Lidarr / Readarr ──────────────────────────────────────────────
// Same *arr HTTP shape as Sonarr/Radarr but served under /api/v1, and their
// calendar entries are single dated releases (an album / a book) rather than
// episodes — so they map to one all-day card each, like a Radarr movie date.

async function arrV1SystemStatus(cfg: IntegrationConfig) {
  const t0 = Date.now();
  const status = await fetchJson<any>(joinUrl(cfg.url, "/api/v1/system/status"), {
    headers: headers(cfg),
  });
  return { ok: true as const, latencyMs: Date.now() - t0, version: status.version };
}

function releaseState(hasFile: boolean, date: string): ReleaseState {
  if (hasFile) return "downloaded";
  return new Date(date).getTime() > Date.now() ? "unaired" : "missing";
}

export const lidarr: IntegrationAdapter = {
  type: "lidarr",
  label: "Lidarr",
  urlPlaceholder: "http://lidarr:8686",
  capabilities: ["queue", "calendar", "status", "storage"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  test: arrV1SystemStatus,

  queueActions: ARR_REMOVE_ONLY,
  runQueueAction: (cfg, id, action) =>
    action === "remove" ? arrRemove(cfg, "v1", id) : Promise.resolve(),

  fetchStorage: (cfg) => fetchArrStorage(cfg, "v1"),

  async fetchQueue(cfg) {
    return fetchArrQueue(cfg, "v1", "&includeArtist=true&includeAlbum=true", (rec) => {
      const artist = rec.artist?.artistName;
      const album = rec.album?.title ?? rec.title;
      return artist && album ? `${artist} · ${album}` : (album ?? artist ?? "Unknown");
    });
  },

  async fetchCalendar(cfg, startIso, endIso, opts?: CalendarOpts) {
    const albums = await fetchJson<any[]>(
      joinUrl(
        cfg.url,
        `/api/v1/calendar?start=${dateOnly(startIso)}&end=${dateOnly(endIso)}` +
          `&includeArtist=true&unmonitored=${opts?.unmonitored ? "true" : "false"}`
      ),
      { headers: headers(cfg) }
    );
    return albums
      .filter((a) => a.releaseDate)
      .map((a): CalendarEvent => {
        const st = a.statistics ?? {};
        const hasFile =
          Number(st.trackCount) > 0 && Number(st.trackFileCount) >= Number(st.trackCount);
        return {
          id: `lidarr-${cfg.id}-${a.id}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          title: a.artist?.artistName ?? "Unknown artist",
          subtitle: a.title,
          airDateUtc: a.releaseDate,
          allDay: true,
          state: releaseState(hasFile, a.releaseDate),
          kind: "movie",
        };
      });
  },
};

export const readarr: IntegrationAdapter = {
  type: "readarr",
  label: "Readarr",
  urlPlaceholder: "http://readarr:8787",
  capabilities: ["queue", "calendar", "status", "storage"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  test: arrV1SystemStatus,

  queueActions: ARR_REMOVE_ONLY,
  runQueueAction: (cfg, id, action) =>
    action === "remove" ? arrRemove(cfg, "v1", id) : Promise.resolve(),

  fetchStorage: (cfg) => fetchArrStorage(cfg, "v1"),

  async fetchQueue(cfg) {
    return fetchArrQueue(cfg, "v1", "&includeAuthor=true&includeBook=true", (rec) => {
      const author = rec.author?.authorName;
      const book = rec.book?.title ?? rec.title;
      return author && book ? `${author} · ${book}` : (book ?? author ?? "Unknown");
    });
  },

  async fetchCalendar(cfg, startIso, endIso, opts?: CalendarOpts) {
    const books = await fetchJson<any[]>(
      joinUrl(
        cfg.url,
        `/api/v1/calendar?start=${dateOnly(startIso)}&end=${dateOnly(endIso)}` +
          `&includeAuthor=true&unmonitored=${opts?.unmonitored ? "true" : "false"}`
      ),
      { headers: headers(cfg) }
    );
    return books
      .filter((b) => b.releaseDate)
      .map((b): CalendarEvent => {
        const st = b.statistics ?? {};
        const hasFile = Number(st.bookFileCount) > 0;
        return {
          id: `readarr-${cfg.id}-${b.id}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          title: b.author?.authorName ?? b.authorTitle ?? "Unknown author",
          subtitle: b.title,
          airDateUtc: b.releaseDate,
          allDay: true,
          state: releaseState(hasFile, b.releaseDate),
          kind: "movie",
        };
      });
  },
};
