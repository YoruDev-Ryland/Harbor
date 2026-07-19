import type { IntegrationAdapter, IntegrationConfig, ProgressItem } from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

/**
 * Kavita — manga/comic/book server. Fleet-status health via /api/health, and a
 * "Continue" widget fed by its on-deck (continue-reading) list. Kavita's REST API
 * is JWT-based: we exchange the API key for a token via the plugin auth endpoint.
 */

async function kavitaToken(cfg: IntegrationConfig): Promise<string> {
  const key = cfg.secrets.apiKey;
  if (!key) throw new Error("Add a Kavita API key for Continue progress");
  const res = await fetchRaw(
    joinUrl(
      cfg.url,
      `/api/Plugin/authenticate?apiKey=${encodeURIComponent(key)}&pluginName=Harbor`
    ),
    { method: "POST" },
    8000
  );
  if (!res.ok) throw new Error(`Kavita auth HTTP ${res.status}`);
  const data: any = await res.json();
  if (!data?.token) throw new Error("Kavita did not return a token");
  return data.token;
}

export const kavita: IntegrationAdapter = {
  type: "kavita",
  label: "Kavita",
  urlPlaceholder: "http://kavita:5000",
  capabilities: ["status", "progress"],
  fields: [{ key: "apiKey", label: "API key (for Continue progress)", type: "password" }],

  async test(cfg: IntegrationConfig) {
    const t0 = Date.now();
    const res = await fetchRaw(joinUrl(cfg.url, "/api/health"), {}, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, latencyMs: Date.now() - t0 };
  },

  async fetchProgress(cfg) {
    const token = await kavitaToken(cfg);
    const h = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    // on-deck is a POST endpoint (paging via query params, no body)
    const data = await fetchJson<any>(
      joinUrl(cfg.url, "/api/Series/on-deck?pageNumber=1&pageSize=20"),
      { method: "POST", headers: h }
    );
    const series: any[] = Array.isArray(data) ? data : (data?.result ?? []);
    return series
      .map((s): ProgressItem => {
        const pages = Number(s.pages) || 0;
        const read = Number(s.pagesRead) || 0;
        return {
          id: `kavita-${cfg.id}-${s.id}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          kind: "book",
          title: s.name ?? "Untitled",
          subtitle: undefined,
          progress: pages > 0 ? Math.max(0, Math.min(1, read / pages)) : 0,
          updatedAt: s.lastChapterAddedUtc
            ? Date.parse(s.lastChapterAddedUtc) || undefined
            : undefined,
        };
      })
      .filter((p) => p.progress < 1);
  },
};
