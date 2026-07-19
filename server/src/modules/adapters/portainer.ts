import type {
  ContainerHealth,
  ContainerInfo,
  ContainerState,
  IntegrationAdapter,
  IntegrationConfig,
} from "../types.js";
import { fetchJson, joinUrl } from "../types.js";

/**
 * Portainer — Docker management. Fleet-status health via public /api/status, and
 * a read-only Containers widget (state + Docker health + uptime) via the Docker
 * proxy. No actions are exposed — the widget is view-only by design.
 */

function apiKey(cfg: IntegrationConfig): string {
  return cfg.secrets.apiKey ?? "";
}

const STATES: ContainerState[] = ["running", "paused", "restarting", "exited", "created", "dead"];
function mapState(raw: string | undefined): ContainerState {
  const s = String(raw ?? "").toLowerCase();
  return (STATES.find((x) => x === s) ?? "exited") as ContainerState;
}

/** Docker's `Status` string carries health, e.g. "Up 2 days (healthy)". */
function parseHealth(status: string | undefined): ContainerHealth {
  const s = String(status ?? "").toLowerCase();
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("health: starting")) return "starting";
  return "none";
}

export const portainer: IntegrationAdapter = {
  type: "portainer",
  label: "Portainer",
  urlPlaceholder: "https://portainer:9443",
  capabilities: ["status", "containers"],
  fields: [{ key: "apiKey", label: "Access token (for the containers widget)", type: "password" }],

  async test(cfg) {
    const t0 = Date.now();
    const data = await fetchJson<any>(joinUrl(cfg.url, "/api/status"));
    return { ok: true, latencyMs: Date.now() - t0, version: data?.Version };
  },

  async fetchContainers(cfg) {
    const key = apiKey(cfg);
    if (!key) throw new Error("Add a Portainer access token to use the containers widget");
    const h = { "X-API-Key": key };
    const endpoints = await fetchJson<any[]>(joinUrl(cfg.url, "/api/endpoints"), { headers: h });
    const multi = (endpoints ?? []).length > 1;
    const out: ContainerInfo[] = [];

    await Promise.all(
      (endpoints ?? []).map(async (ep: any) => {
        try {
          const containers = await fetchJson<any[]>(
            joinUrl(cfg.url, `/api/endpoints/${ep.Id}/docker/containers/json?all=1`),
            { headers: h }
          );
          for (const c of containers ?? []) {
            const name = (c.Names?.[0] ?? "").replace(/^\//, "") || String(c.Id ?? "").slice(0, 12);
            out.push({
              id: `portainer-${cfg.id}-${ep.Id}-${String(c.Id ?? "").slice(0, 12)}`,
              source: { id: cfg.id, type: cfg.type, name: cfg.name },
              name: name || "container",
              env: multi ? ep.Name || undefined : undefined,
              state: mapState(c.State),
              up: String(c.State).toLowerCase() === "running",
              health: parseHealth(c.Status),
              status: c.Status ?? "",
              image: c.Image || undefined,
            });
          }
        } catch {
          /* one environment failing shouldn't drop the others */
        }
      })
    );
    return out;
  },
};
