import type { IntegrationAdapter, IntegrationConfig, ProgressItem } from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

/**
 * Audiobookshelf — Fleet-status health (public /ping) and a "Continue" widget
 * fed by the listener's in-progress items. Uses the user's API token as a
 * Bearer credential.
 */
function authHeaders(cfg: IntegrationConfig): Record<string, string> {
  return cfg.secrets.apiKey ? { Authorization: `Bearer ${cfg.secrets.apiKey}` } : {};
}

function authorOf(md: any): string | undefined {
  if (md?.authorName) return md.authorName;
  if (Array.isArray(md?.authors))
    return (
      md.authors
        .map((a: any) => a.name)
        .filter(Boolean)
        .join(", ") || undefined
    );
  return undefined;
}

export const audiobookshelf: IntegrationAdapter = {
  type: "audiobookshelf",
  label: "Audiobookshelf",
  urlPlaceholder: "http://audiobookshelf:13378",
  capabilities: ["status", "progress"],
  fields: [{ key: "apiKey", label: "API token (for Continue progress)", type: "password" }],

  async test(cfg: IntegrationConfig) {
    const t0 = Date.now();
    const res = await fetchRaw(joinUrl(cfg.url, "/ping"), {}, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let version: string | undefined;
    try {
      const s = await fetchJson<any>(joinUrl(cfg.url, "/status"));
      version = s?.serverVersion || s?.version || undefined;
    } catch {
      /* version is best-effort */
    }
    return { ok: true, latencyMs: Date.now() - t0, version };
  },

  async fetchProgress(cfg) {
    if (!cfg.secrets.apiKey) throw new Error("Add an Audiobookshelf API token for Continue");
    const data = await fetchJson<any>(joinUrl(cfg.url, "/api/me/items-in-progress"), {
      headers: authHeaders(cfg),
    });
    const items: any[] = data?.libraryItems ?? [];
    return items
      .map((it): ProgressItem => {
        const md = it.media?.metadata ?? {};
        const prog = Number(
          it.progress ?? it.userMediaProgress?.progress ?? it.mediaProgress?.progress ?? 0
        );
        return {
          id: `abs-${cfg.id}-${it.id}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          kind: "audiobook",
          title: md.title ?? "Untitled",
          subtitle: authorOf(md),
          progress: Math.max(0, Math.min(1, prog)),
          updatedAt: Number(it.progressLastUpdate ?? it.updatedAt ?? 0) || undefined,
        };
      })
      .filter((p) => p.progress < 1);
  },
};
