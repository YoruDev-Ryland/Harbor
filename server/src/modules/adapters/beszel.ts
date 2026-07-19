import type {
  HostMetric,
  HostState,
  IntegrationAdapter,
  IntegrationConfig,
  StorageMount,
} from "../types.js";
import { fetchRaw, joinUrl } from "../types.js";

/**
 * Beszel — lightweight server monitoring hub. The hub is a PocketBase app, so
 * it exposes PocketBase's REST API: authenticate against the `users` collection
 * with email + password, then read the `systems` collection. Each system record
 * carries an `info` JSON snapshot (the same data the hub's "All Systems" table
 * shows) with short keys — cpu, mp (mem %), dp (disk %), bb (bandwidth B/s),
 * u (uptime s), c (cores), m (cpu model), g (gpu %), dt (temp °C).
 *
 * Auth tokens are cached per integration and refreshed transparently on 401.
 */

const tokens = new Map<number, string>();

async function authenticate(cfg: IntegrationConfig): Promise<string> {
  const res = await fetchRaw(joinUrl(cfg.url, "/api/collections/users/auth-with-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: cfg.secrets.email ?? "",
      password: cfg.secrets.password ?? "",
    }),
  });
  if (res.status === 400 || res.status === 401)
    throw new Error("Beszel login failed — check the hub email and password");
  if (!res.ok) throw new Error(`Beszel auth HTTP ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Beszel returned no auth token");
  tokens.set(cfg.id, data.token);
  return data.token;
}

async function listSystems(cfg: IntegrationConfig): Promise<any[]> {
  const path = "/api/collections/systems/records?perPage=200&sort=name";
  const get = (token: string) =>
    fetchRaw(joinUrl(cfg.url, path), { headers: { Authorization: token } });

  let token = tokens.get(cfg.id) ?? (await authenticate(cfg));
  let res = await get(token);
  if (res.status === 401) {
    token = await authenticate(cfg);
    res = await get(token);
  }
  if (!res.ok) throw new Error(`Beszel HTTP ${res.status}`);
  const data = (await res.json()) as { items?: any[] };
  return data.items ?? [];
}

function pct(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
}

function hostState(status: string): HostState {
  return status === "up" || status === "down" || status === "paused" ? status : "pending";
}

export const beszel: IntegrationAdapter = {
  type: "beszel",
  label: "Beszel",
  urlPlaceholder: "http://beszel:8090",
  capabilities: ["system", "status", "storage"],
  fields: [
    { key: "email", label: "Hub email", type: "text", required: true },
    { key: "password", label: "Hub password", type: "password", required: true },
  ],

  async test(cfg) {
    const t0 = Date.now();
    const systems = await listSystems(cfg);
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      message: `${systems.length} host${systems.length === 1 ? "" : "s"} monitored`,
    };
  },

  async fetchSystems(cfg) {
    const systems = await listSystems(cfg);
    return systems.map((rec): HostMetric => {
      const info = rec.info ?? {};
      // bb = BandwidthBytes (B/s); older agents only report b (MB/s, deprecated)
      const netBps =
        info.bb != null ? Number(info.bb) : info.b ? Number(info.b) * 1_000_000 : undefined;
      return {
        id: `beszel-${cfg.id}-${rec.id}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        name: rec.name ?? info.h ?? "host",
        status: hostState(rec.status),
        cpuPct: pct(info.cpu),
        memPct: pct(info.mp),
        diskPct: pct(info.dp),
        gpuPct: pct(info.g),
        netBps: netBps && netBps > 0 ? netBps : undefined,
        uptimeSec: Number(info.u) || undefined,
        cores: Number(info.c) || undefined,
        cpuModel: info.m || undefined,
        hostname: info.h || undefined,
        tempC: Number(info.dt) || undefined,
        agentVersion: info.v || undefined,
      };
    });
  },

  async fetchStorage(cfg) {
    // Beszel's system `info` snapshot carries disk % (dp) but no absolute bytes,
    // so each host's root filesystem becomes a percentage-only fullness bar.
    const systems = await listSystems(cfg);
    return systems
      .map((rec): StorageMount | null => {
        const used = pct(rec.info?.dp);
        if (used == null) return null;
        return {
          id: `beszel-${cfg.id}-${rec.id}`,
          source: { id: cfg.id, type: cfg.type, name: cfg.name },
          label: rec.name ?? rec.info?.h ?? "host",
          usedPct: used,
        };
      })
      .filter((m): m is StorageMount => m !== null);
  },
};
