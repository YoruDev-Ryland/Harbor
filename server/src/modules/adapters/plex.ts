import type {
  CalendarEvent,
  IntegrationAdapter,
  IntegrationConfig,
  NowPlayingSession,
  PlaybackState,
  RecentItem,
  StreamDecision,
} from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

function headers(cfg: IntegrationConfig): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Token": cfg.secrets.token ?? "",
  };
}

function plexWebRoot(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const root = base.includes("/web") ? base.split("#")[0] : `${base}/web/index.html`;
  return root.endsWith("/web") ? `${root}/index.html` : root;
}

function itemGuids(item: any): string[] {
  return [item.guid, ...(item.Guid ?? []).map((g: any) => g.id)].filter(Boolean);
}

/**
 * External-id match tolerant of Plex's many guid dialects — the clean modern
 * `tvdb://123`, suffixed `tvdb://123?lang=en`, and legacy/anime agents like
 * `com.plexapp.agents.thetvdb://123` or `com.plexapp.agents.hama://tvdb-123`.
 * The trailing `(?!\d)` keeps `tvdb://123` from matching `tvdb://1234`.
 */
function guidMatches(guids: string[], provider: string, id: string | number): boolean {
  const idPat = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${provider}[:/-]+${idPat}(?!\\d)`, "i");
  return guids.some((g) => re.test(g));
}

function idScoreFor(ev: CalendarEvent, guids: string[]): number {
  const ids = ev.externalIds ?? {};
  let score = 0;
  if (ids.imdb && guidMatches(guids, "imdb", ids.imdb)) score += 100;
  if (ids.tvdb && guidMatches(guids, "tvdb", ids.tvdb)) score += 100;
  if (ids.tmdb && guidMatches(guids, "tmdb", ids.tmdb)) score += 100;
  return score;
}

/** Normalize for tolerant title comparison: drop year/country tags, "the",
 *  punctuation, and expand `&`, so "Marvel's Daredevil" ≈ "Daredevil (2015)". */
function normalizeTitle(s: string | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // fold diacritics: "Shōgun" → "Shogun"
    .toLowerCase()
    .replace(/\(\d{4}\)/g, " ")
    .replace(/\((?:us|uk|jp|au|ca|nz)\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(ev: CalendarEvent, item: any): number {
  const a = normalizeTitle(item.title);
  const b = normalizeTitle(ev.title);
  if (!a || !b) return 0;
  // spacing-insensitive: "MARRIAGETOXIN" (Sonarr) == "Marriage Toxin" (Plex)
  const ca = a.replace(/ /g, "");
  const cb = b.replace(/ /g, "");
  if (a === b || ca === cb) return 40;
  if (a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a)) return 18;
  if (ca.startsWith(cb) || cb.startsWith(ca) || ca.includes(cb) || cb.includes(ca)) return 15;
  return 0;
}

function searchItems(data: any, ev: CalendarEvent): any[] {
  const wantedType = ev.kind === "movie" ? "movie" : "show";
  const hubs: any[] = data.MediaContainer?.Hub ?? [];
  const flat = hubs.flatMap((hub) => hub.Metadata ?? []);
  // some Plex builds return results under SearchResult instead of Hub
  const results: any[] = (data.MediaContainer?.SearchResult ?? [])
    .map((r: any) => r.Metadata)
    .filter(Boolean);
  return [...flat, ...results].filter((item) => item?.type === wantedType);
}

/** Fetch an item's full metadata (which reliably includes the external-id Guid
 *  array) when the search results omitted it. */
async function fetchItemGuids(cfg: IntegrationConfig, ratingKey: string): Promise<string[]> {
  try {
    const data = await fetchJson<any>(
      joinUrl(cfg.url, `/library/metadata/${ratingKey}?includeGuids=1`),
      { headers: headers(cfg) }
    );
    const item = data.MediaContainer?.Metadata?.[0];
    return item ? itemGuids(item) : [];
  } catch {
    return [];
  }
}

export async function resolvePlexItemUrl(
  cfg: IntegrationConfig,
  browserBaseUrl: string,
  ev: CalendarEvent
): Promise<string | undefined> {
  const [identity, search] = await Promise.all([
    fetchJson<any>(joinUrl(cfg.url, "/identity"), { headers: headers(cfg) }),
    fetchJson<any>(
      joinUrl(
        cfg.url,
        `/hubs/search?query=${encodeURIComponent(ev.title)}&includeCollections=0&includeGuids=1&limit=30`
      ),
      { headers: headers(cfg) }
    ),
  ]);

  const machineIdentifier = identity.MediaContainer?.machineIdentifier;
  if (!machineIdentifier) return undefined;

  const candidates = searchItems(search, ev);
  if (candidates.length === 0) {
    // Visible in `docker logs harbor` — Plex's own search returned nothing for
    // this title, so there's nothing to deep-link to (we fall back to search).
    console.warn(
      `[plex] no ${ev.kind === "movie" ? "movie" : "show"} results for "${ev.title}" — Plex search returned 0 matches`
    );
    return undefined;
  }

  const scoreOf = (item: any, guids: string[]) => idScoreFor(ev, guids) + titleScore(ev, item);
  const scored = candidates
    .map((item) => {
      const guids = itemGuids(item);
      return { item, guids, score: scoreOf(item, guids), idMatched: idScoreFor(ev, guids) > 0 };
    })
    .sort((a, b) => b.score - a.score);

  let best = scored[0];

  // If the leader isn't confirmed by an external id yet but the event has ids,
  // the search likely stripped the Guid array — pull full metadata for the top
  // few candidates (which includes guids) and re-score against it.
  const haveIds = !!ev.externalIds && Object.values(ev.externalIds).some(Boolean);
  if (!best.idMatched && haveIds) {
    const rescored = await Promise.all(
      scored.slice(0, 4).map(async (c) => {
        const guids = await fetchItemGuids(cfg, c.item.ratingKey);
        return { ...c, score: scoreOf(c.item, guids), idMatched: idScoreFor(ev, guids) > 0 };
      })
    );
    rescored.sort((a, b) => b.score - a.score);
    if (rescored[0].score >= best.score) best = rescored[0];
  }

  // Accept a confident match: any external-id hit, a decent title match, or a
  // lone result — if Plex returned exactly one item of this type for the query,
  // that's the show the user meant (matches "it's the only matching show").
  const accept = best.idMatched || best.score >= 15 || candidates.length === 1;
  if (!accept || !best.item?.ratingKey) {
    console.warn(
      `[plex] no confident match for "${ev.title}" (${ev.kind}). Candidates: ` +
        scored
          .slice(0, 4)
          .map((c) => `"${c.item.title}"[score ${c.score}${c.idMatched ? " id" : ""}]`)
          .join(", ")
    );
    return undefined;
  }

  const key = encodeURIComponent(`/library/metadata/${best.item.ratingKey}`);
  return `${plexWebRoot(browserBaseUrl)}#!/server/${machineIdentifier}/details?key=${key}`;
}

/** Build an exact Plex Web deep link when the caller already has a rating key. */
export async function resolvePlexRatingKeyUrl(
  cfg: IntegrationConfig,
  browserBaseUrl: string,
  ratingKey: string
): Promise<string | undefined> {
  const identity = await fetchJson<any>(joinUrl(cfg.url, "/identity"), { headers: headers(cfg) });
  const machineIdentifier = identity.MediaContainer?.machineIdentifier;
  if (!machineIdentifier) return undefined;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `${plexWebRoot(browserBaseUrl)}#!/server/${machineIdentifier}/details?key=${key}`;
}

function playbackState(raw: string | undefined): PlaybackState {
  return raw === "paused" ? "paused" : raw === "buffering" ? "buffering" : "playing";
}

function sessionKind(type: string | undefined): NowPlayingSession["kind"] {
  switch (type) {
    case "movie":
    case "episode":
    case "track":
    case "photo":
    case "clip":
      return type;
    default:
      return "unknown";
  }
}

/** Plex marks a stream as transcoding via a TranscodeSession; absent = direct play. */
function streamDecision(item: any): StreamDecision {
  const ts = item.TranscodeSession;
  if (!ts) return "direct play";
  return ts.videoDecision === "transcode" || ts.audioDecision === "transcode"
    ? "transcode"
    : "direct stream";
}

function sessionSubtitle(item: any): string | undefined {
  if (item.type === "episode") {
    const s = item.parentIndex;
    const e = item.index;
    const code =
      s != null && e != null
        ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`
        : undefined;
    return [code, item.title].filter(Boolean).join(" · ") || undefined;
  }
  if (item.type === "track") return item.parentTitle || undefined; // album
  if (item.type === "movie" && item.year) return String(item.year);
  return undefined;
}

function recentKind(type: string | undefined): RecentItem["kind"] {
  switch (type) {
    case "movie":
      return "movie";
    case "show":
    case "season":
      return "show";
    case "episode":
      return "episode";
    case "album":
    case "track":
      return "album";
    default:
      return "unknown";
  }
}

export function plexRecentFields(item: any): Omit<RecentItem, "id" | "source"> {
  const episodic = item.type === "episode" || item.type === "season";
  const seriesTitle =
    item.type === "season"
      ? item.parentTitle || item.grandparentTitle
      : item.grandparentTitle || item.parentTitle;
  const art =
    (item.type === "season"
      ? item.parentThumb || item.grandparentThumb
      : episodic
        ? item.grandparentThumb || item.parentThumb
        : item.thumb) || item.thumb;
  const title = episodic ? seriesTitle || item.title : item.title;
  const recentSubtitle = item.type === "season" ? item.title || undefined : sessionSubtitle(item);
  return {
    kind: recentKind(item.type),
    title: title || "Untitled",
    subtitle: recentSubtitle || (item.year ? String(item.year) : undefined),
    artPath: art ? safeArtPath(art) : undefined,
    ratingKey: item.ratingKey != null ? String(item.ratingKey) : undefined,
    addedAt: item.addedAt ? Number(item.addedAt) * 1000 : undefined,
  };
}

/** Only allow proxying Plex's own art paths — never an arbitrary URL. */
function safeArtPath(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  if (path.includes("://") || path.includes("..")) return undefined;
  return /^\/(library|photo)\//.test(path) ? path : undefined;
}

export const plex: IntegrationAdapter = {
  type: "plex",
  label: "Plex",
  urlPlaceholder: "http://plex:32400",
  capabilities: ["status", "nowPlaying", "recentlyAdded"],
  fields: [{ key: "token", label: "Plex token", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const data = await fetchJson<any>(joinUrl(cfg.url, "/identity"), { headers: headers(cfg) });
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      version: data.MediaContainer?.version,
    };
  },

  async fetchNowPlaying(cfg) {
    const data = await fetchJson<any>(joinUrl(cfg.url, "/status/sessions"), {
      headers: headers(cfg),
    });
    const items: any[] = data.MediaContainer?.Metadata ?? [];
    return items.map((item): NowPlayingSession => {
      const duration = Number(item.duration) || 0;
      const offset = Number(item.viewOffset) || 0;
      const art = item.grandparentThumb || item.thumb || item.art || undefined;
      return {
        id: `plex-${cfg.id}-${item.sessionKey ?? item.ratingKey}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: item.title ?? "Unknown",
        grandparentTitle: item.grandparentTitle || undefined,
        subtitle: sessionSubtitle(item),
        kind: sessionKind(item.type),
        user: item.User?.title || undefined,
        player: item.Player?.title || undefined,
        state: playbackState(item.Player?.state),
        progress: duration > 0 ? Math.min(1, offset / duration) : 0,
        durationMs: duration || undefined,
        viewOffsetMs: offset || undefined,
        decision: streamDecision(item),
        bandwidthKbps: Number(item.Session?.bandwidth) || undefined,
        artPath: art ? safeArtPath(art) : undefined,
      };
    });
  },

  async fetchRecentlyAdded(cfg) {
    const data = await fetchJson<any>(
      joinUrl(cfg.url, "/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=40"),
      { headers: headers(cfg) }
    );
    const items: any[] = data.MediaContainer?.Metadata ?? [];
    return items.map((item): RecentItem => {
      return {
        id: `plex-${cfg.id}-${item.ratingKey}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        ...plexRecentFields(item),
      };
    });
  },

  async fetchArt(cfg, artPath) {
    const safe = safeArtPath(artPath);
    if (!safe) throw new Error("invalid art path");
    return fetchRaw(joinUrl(cfg.url, safe), { headers: headers(cfg) }, 8000);
  },
};
