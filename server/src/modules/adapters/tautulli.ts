import type {
  IntegrationAdapter,
  IntegrationConfig,
  NowPlayingSession,
  PlaybackState,
  RecentItem,
  StreamDecision,
} from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

/**
 * Tautulli — a companion to Plex. It exposes richer now-playing data than Plex
 * itself (per-stream transcode decision, bandwidth, users). Because it reads the
 * *same* Plex server, the now-playing endpoint de-duplicates Tautulli vs. Plex
 * and keeps Tautulli's copy (see dedupeNowPlaying in routes/widgets).
 */

function apiUrl(cfg: IntegrationConfig, cmd: string, extra: Record<string, string | number> = {}) {
  const u = new URL(joinUrl(cfg.url, "/api/v2"));
  u.searchParams.set("apikey", cfg.secrets.apiKey ?? "");
  u.searchParams.set("cmd", cmd);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function tautulliCmd(
  cfg: IntegrationConfig,
  cmd: string,
  extra: Record<string, string | number> = {}
): Promise<any> {
  const data = await fetchJson<any>(apiUrl(cfg, cmd, extra));
  const r = data?.response;
  if (!r || r.result !== "success") throw new Error(r?.message || "Tautulli API error");
  return r.data;
}

function recentKind(t?: string): RecentItem["kind"] {
  switch (t) {
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

function playbackState(s?: string): PlaybackState {
  return s === "paused" ? "paused" : s === "buffering" ? "buffering" : "playing";
}

function decision(d?: string): StreamDecision {
  if (d === "transcode") return "transcode";
  if (d === "copy") return "direct stream";
  return "direct play";
}

function sessionKind(t?: string): NowPlayingSession["kind"] {
  switch (t) {
    case "movie":
    case "episode":
    case "track":
    case "photo":
    case "clip":
      return t;
    default:
      return "unknown";
  }
}

function subtitle(s: any): string | undefined {
  if (s.media_type === "episode") {
    const se = s.parent_media_index;
    const ep = s.media_index;
    const code =
      se && ep ? `S${String(se).padStart(2, "0")}E${String(ep).padStart(2, "0")}` : undefined;
    return [code, s.title].filter(Boolean).join(" · ") || undefined;
  }
  if (s.media_type === "track") return s.parent_title || undefined;
  if (s.media_type === "movie" && s.year) return String(s.year);
  return undefined;
}

export function tautulliRecentFields(s: any): Omit<RecentItem, "id" | "source"> {
  const episodic = s.media_type === "episode" || s.media_type === "season";
  const seriesTitle =
    s.media_type === "season"
      ? s.parent_title || s.grandparent_title
      : s.grandparent_title || s.parent_title;
  const art =
    (s.media_type === "season"
      ? s.parent_thumb || s.grandparent_thumb
      : episodic
        ? s.grandparent_thumb || s.parent_thumb
        : s.thumb) || s.thumb;
  const title = episodic ? seriesTitle || s.title : s.title;
  const recentSubtitle = s.media_type === "season" ? s.title || undefined : subtitle(s);
  return {
    kind: recentKind(s.media_type),
    title: title || "Untitled",
    subtitle: recentSubtitle || (s.year ? String(s.year) : undefined),
    artPath: art || undefined,
    ratingKey: s.rating_key != null ? String(s.rating_key) : undefined,
    addedAt: s.added_at ? Number(s.added_at) * 1000 : undefined,
  };
}

export const tautulli: IntegrationAdapter = {
  type: "tautulli",
  label: "Tautulli",
  urlPlaceholder: "http://tautulli:8181",
  capabilities: ["nowPlaying", "status", "recentlyAdded"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const info = await tautulliCmd(cfg, "get_server_info");
    return { ok: true, latencyMs: Date.now() - t0, version: info?.pms_version };
  },

  async fetchNowPlaying(cfg) {
    const data = await tautulliCmd(cfg, "get_activity");
    const sessions: any[] = data?.sessions ?? [];
    return sessions.map((s): NowPlayingSession => {
      const duration = Number(s.duration) || 0;
      const offset = Number(s.view_offset) || 0;
      const art = s.grandparent_thumb || s.thumb || s.art || undefined;
      return {
        id: `tautulli-${cfg.id}-${s.session_key ?? s.session_id}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: s.title || s.full_title || "Unknown",
        grandparentTitle: s.grandparent_title || undefined,
        subtitle: subtitle(s),
        kind: sessionKind(s.media_type),
        user: s.friendly_name || s.user || undefined,
        player: s.player || s.platform || undefined,
        state: playbackState(s.state),
        progress:
          duration > 0 ? Math.min(1, offset / duration) : (Number(s.progress_percent) || 0) / 100,
        durationMs: duration || undefined,
        viewOffsetMs: offset || undefined,
        decision: decision(s.transcode_decision),
        bandwidthKbps: Number(s.bandwidth) || undefined,
        artPath: art || undefined,
      };
    });
  },

  async fetchRecentlyAdded(cfg) {
    const data = await tautulliCmd(cfg, "get_recently_added", { count: 40 });
    const rows: any[] = data?.recently_added ?? [];
    return rows.map((s): RecentItem => {
      return {
        id: `tautulli-${cfg.id}-${s.rating_key}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        ...tautulliRecentFields(s),
      };
    });
  },

  async fetchArt(cfg, artPath) {
    if (!artPath || artPath.includes("://") || artPath.includes("..")) {
      throw new Error("invalid art path");
    }
    // Tautulli proxies Plex artwork through its own image endpoint
    return fetchRaw(apiUrl(cfg, "pms_image_proxy", { img: artPath, width: 300 }), {}, 8000);
  },
};
