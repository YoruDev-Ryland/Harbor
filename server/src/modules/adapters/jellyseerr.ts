import type { IntegrationAdapter, IntegrationConfig, RequestItem } from "../types.js";
import { fetchJson, joinUrl } from "../types.js";

/**
 * The Overseerr request-manager family — Overseerr, Jellyseerr, and the Seerr
 * forks all share the same /api/v1 API, so one adapter covers them all. Harbor
 * uses it purely to learn *who requested what*, so a finished download can be
 * attributed to the requester's email. No widget; it feeds notifications.
 */

function headers(cfg: IntegrationConfig): Record<string, string> {
  return { "X-Api-Key": cfg.secrets.apiKey ?? "" };
}

export const jellyseerr: IntegrationAdapter = {
  type: "jellyseerr",
  label: "Seerr / Jellyseerr",
  urlPlaceholder: "http://seerr:5055",
  capabilities: [],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const status = await fetchJson<any>(joinUrl(cfg.url, "/api/v1/status"), {
      headers: headers(cfg),
    });
    return { ok: true, latencyMs: Date.now() - t0, version: status?.version };
  },

  async fetchRequests(cfg) {
    // most-recent requests first; one page of 100 comfortably covers anything
    // still downloading. Each result carries the media ids + the requester.
    const data = await fetchJson<any>(
      joinUrl(cfg.url, "/api/v1/request?take=100&skip=0&filter=all&sort=added"),
      { headers: headers(cfg) }
    );
    const results: any[] = data?.results ?? [];
    const out: RequestItem[] = [];
    for (const r of results) {
      const email = r?.requestedBy?.email;
      if (!email) continue;
      out.push({
        requestedByEmail: String(email).trim().toLowerCase(),
        mediaType: r?.type === "movie" ? "movie" : "tv",
        tmdbId: Number(r?.media?.tmdbId) || undefined,
        tvdbId: Number(r?.media?.tvdbId) || undefined,
        title: r?.media?.title ?? r?.media?.name ?? undefined,
      });
    }
    return out;
  },
};
