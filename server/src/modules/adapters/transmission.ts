import type { DownloadItem, DownloadState, IntegrationConfig } from "../types.js";
import type { IntegrationAdapter } from "../types.js";
import { fetchRaw, joinUrl } from "../types.js";

/**
 * Transmission RPC. Like qBittorrent, Transmission has no separate REST API —
 * its Web UI talks to the daemon over an RPC endpoint at /transmission/rpc.
 *
 * Two wrinkles the adapter handles transparently:
 *  - CSRF: the first call returns 409 with the correct `X-Transmission-Session-Id`
 *    header, which every subsequent call must echo back. We cache it per
 *    integration and refresh on the next 409.
 *  - Auth is optional HTTP Basic (username/password) — omit both if the RPC is open.
 */

const sessionIds = new Map<number, string>();

const RPC_PATH = "/transmission/rpc";

function authHeader(cfg: IntegrationConfig): Record<string, string> {
  const user = cfg.secrets.username ?? "";
  const pass = cfg.secrets.password ?? "";
  if (!user && !pass) return {};
  return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
}

/** POST an RPC call, performing the 409 session-id handshake at most once. */
async function rpc<T = any>(
  cfg: IntegrationConfig,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const url = joinUrl(cfg.url, RPC_PATH);
  const body = JSON.stringify({ method, arguments: args });

  const call = (sid: string | undefined) =>
    fetchRaw(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sid ? { "X-Transmission-Session-Id": sid } : {}),
        ...authHeader(cfg),
      },
      body,
    });

  let res = await call(sessionIds.get(cfg.id));
  if (res.status === 409) {
    const sid = res.headers.get("x-transmission-session-id");
    if (!sid) throw new Error("Transmission did not return a session id");
    sessionIds.set(cfg.id, sid);
    res = await call(sid);
  }
  if (res.status === 401) throw new Error("Transmission auth failed — check username/password");
  if (!res.ok) throw new Error(`Transmission HTTP ${res.status}`);

  const data = (await res.json()) as { result: string; arguments?: T };
  if (data.result !== "success") throw new Error(`Transmission RPC: ${data.result}`);
  return data.arguments as T;
}

/** Transmission's numeric torrent status → Harbor's normalized state. */
function mapState(status: number, error: number): DownloadState {
  if (error !== 0) return "error";
  switch (status) {
    case 0: // stopped / paused
      return "paused";
    case 1: // queued to verify
    case 3: // queued to download
      return "queued";
    case 5: // queued to seed
    case 6: // seeding = finished downloading
      return "completed";
    default: // 2 verifying, 4 downloading
      return "downloading";
  }
}

export const transmission: IntegrationAdapter = {
  type: "transmission",
  label: "Transmission",
  urlPlaceholder: "http://transmission:9091",
  capabilities: ["queue", "status"],
  fields: [
    { key: "username", label: "RPC username", type: "text", placeholder: "(if auth enabled)" },
    { key: "password", label: "RPC password", type: "password", placeholder: "(if auth enabled)" },
  ],

  queueActions: ["pause", "resume", "remove", "priorityUp", "priorityDown"],

  async runQueueAction(cfg, id, action) {
    const ids = [Number(id)];
    switch (action) {
      case "pause":
        return void (await rpc(cfg, "torrent-stop", { ids }));
      case "resume":
        return void (await rpc(cfg, "torrent-start", { ids }));
      case "remove":
        return void (await rpc(cfg, "torrent-remove", { ids, "delete-local-data": false }));
      case "priorityUp":
        return void (await rpc(cfg, "queue-move-up", { ids }));
      case "priorityDown":
        return void (await rpc(cfg, "queue-move-down", { ids }));
    }
  },

  async test(cfg) {
    const t0 = Date.now();
    const session = await rpc<{ version: string }>(cfg, "session-get", { fields: ["version"] });
    return { ok: true, latencyMs: Date.now() - t0, version: session.version };
  },

  async fetchQueue(cfg) {
    const data = await rpc<{ torrents: any[] }>(cfg, "torrent-get", {
      fields: [
        "id",
        "name",
        "status",
        "error",
        "percentDone",
        "totalSize",
        "leftUntilDone",
        "rateDownload",
        "eta",
        "errorString",
      ],
    });
    const torrents = data.torrents ?? [];
    return (
      torrents
        // mirror qBittorrent's "downloading" filter: hide finished seeders
        .filter((t) => t.status !== 5 && t.status !== 6)
        .map((t): DownloadItem => {
          const size = Number(t.totalSize) || 0;
          const left = Number(t.leftUntilDone) || 0;
          const eta = Number(t.eta);
          return {
            id: `transmission-${cfg.id}-${t.id}`,
            source: { id: cfg.id, type: cfg.type, name: cfg.name },
            title: t.name,
            state: mapState(Number(t.status), Number(t.error) || 0),
            progress: Number(t.percentDone) || (size > 0 ? (size - left) / size : 0),
            sizeBytes: size,
            sizeLeftBytes: left,
            speedBps: Number(t.rateDownload) || undefined,
            etaSeconds: eta && eta > 0 ? eta : undefined,
            errorMessage: t.errorString || undefined,
          };
        })
    );
  },
};
