import type { IndexerStatus, IntegrationAdapter, IntegrationConfig } from "../types.js";
import { fetchJson, joinUrl } from "../types.js";

/**
 * Prowlarr — indexer manager. Feeds Fleet status (reachability) and the Indexers
 * widget (per-indexer up/down). "Up" = enabled and not flagged in Prowlarr's own
 * health warnings; a disabled indexer is shown as disabled, not down.
 */
function headers(cfg: IntegrationConfig): Record<string, string> {
  return { "X-Api-Key": cfg.secrets.apiKey ?? "" };
}

export const prowlarr: IntegrationAdapter = {
  type: "prowlarr",
  label: "Prowlarr",
  urlPlaceholder: "http://prowlarr:9696",
  capabilities: ["status", "indexers"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const status = await fetchJson<any>(joinUrl(cfg.url, "/api/v1/system/status"), {
      headers: headers(cfg),
    });
    return { ok: true, latencyMs: Date.now() - t0, version: status.version };
  },

  async fetchIndexers(cfg) {
    const [indexers, health] = await Promise.all([
      fetchJson<any[]>(joinUrl(cfg.url, "/api/v1/indexer"), { headers: headers(cfg) }),
      fetchJson<any[]>(joinUrl(cfg.url, "/api/v1/health"), { headers: headers(cfg) }).catch(
        () => [] as any[]
      ),
    ]);
    // Prowlarr surfaces failing indexers as health warnings that name them
    const warnText = (health ?? [])
      .map((w: any) => String(w?.message ?? ""))
      .join(" | ")
      .toLowerCase();

    return (indexers ?? []).map((ix: any): IndexerStatus => {
      const enabled = !!ix.enable;
      const name = ix.name ?? "Indexer";
      const troubled = enabled && name && warnText.includes(String(name).toLowerCase());
      return {
        id: `prowlarr-${cfg.id}-${ix.id}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        name,
        enabled,
        up: enabled && !troubled,
        message: troubled ? "recent failures" : undefined,
      };
    });
  },
};
