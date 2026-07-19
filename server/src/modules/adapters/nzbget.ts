import type { DownloadItem, DownloadState, IntegrationConfig } from "../types.js";
import type { IntegrationAdapter } from "../types.js";
import { fetchJson, joinUrl } from "../types.js";

/**
 * NZBGet — Usenet downloader. Like Transmission it exposes a JSON-RPC endpoint
 * (/jsonrpc) rather than a REST API, guarded by HTTP Basic auth
 * (ControlUsername / ControlPassword). We map its download queue into the
 * unified Downloads widget alongside SABnzbd.
 */

const MB = 1024 * 1024;

function authHeader(cfg: IntegrationConfig): Record<string, string> {
  const user = cfg.secrets.username ?? "";
  const pass = cfg.secrets.password ?? "";
  if (!user && !pass) return {};
  return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
}

async function rpc<T = any>(
  cfg: IntegrationConfig,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { message: string } }>(
    joinUrl(cfg.url, "/jsonrpc"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(cfg) },
      body: JSON.stringify({ method, params, jsonrpc: "2.0", id: 1 }),
    }
  );
  if (res.error) throw new Error(`NZBGet: ${res.error.message}`);
  return res.result as T;
}

const POST_PROCESS = [
  "LOADING_PARS",
  "VERIFYING",
  "REPAIRING",
  "RENAMING",
  "UNPACKING",
  "MOVING",
  "EXECUTING_SCRIPT",
];

function mapState(status: string): DownloadState {
  const s = (status || "").toUpperCase();
  if (s.includes("PAUSED")) return "paused";
  if (s.startsWith("PP_") || s === "POSTPROCESSING" || POST_PROCESS.some((p) => s.includes(p)))
    return "importing";
  if (s.includes("QUEUED")) return "queued";
  // DOWNLOADING / FETCHING and anything else in-flight
  return "downloading";
}

export const nzbget: IntegrationAdapter = {
  type: "nzbget",
  label: "NZBGet",
  urlPlaceholder: "http://nzbget:6789",
  capabilities: ["queue", "status"],
  fields: [
    { key: "username", label: "Control username", type: "text", placeholder: "nzbget" },
    { key: "password", label: "Control password", type: "password" },
  ],

  queueActions: ["pause", "resume", "remove", "priorityUp", "priorityDown"],

  async runQueueAction(cfg, id, action) {
    const nzbId = Number(id);
    // editqueue(Command, Offset, EditText, IDs[])
    const call = (command: string, offset = 0) =>
      rpc(cfg, "editqueue", [command, offset, "", [nzbId]]);
    switch (action) {
      case "pause":
        return void (await call("GroupPause"));
      case "resume":
        return void (await call("GroupResume"));
      case "remove":
        return void (await call("GroupDelete"));
      case "priorityUp":
        return void (await call("GroupMoveOffset", -1));
      case "priorityDown":
        return void (await call("GroupMoveOffset", 1));
    }
  },

  async test(cfg) {
    const t0 = Date.now();
    const version = await rpc<string>(cfg, "version");
    return { ok: true, latencyMs: Date.now() - t0, version };
  },

  async fetchQueue(cfg) {
    const [groups, status] = await Promise.all([
      rpc<any[]>(cfg, "listgroups", [0]),
      rpc<any>(cfg, "status").catch(() => null),
    ]);
    const globalRate = Number(status?.DownloadRate) || 0; // bytes/sec across the queue
    let rateAssigned = false;

    return (groups ?? []).map((g): DownloadItem => {
      const sizeBytes = (Number(g.FileSizeMB) || 0) * MB;
      const leftBytes = (Number(g.RemainingSizeMB) || 0) * MB;
      const state = mapState(g.Status);
      // NZBGet reports one aggregate speed — hand it to the first active item
      const isActive = state === "downloading" && !rateAssigned && globalRate > 0;
      if (isActive) rateAssigned = true;
      const speedBps = isActive ? globalRate : undefined;
      return {
        id: `nzbget-${cfg.id}-${g.NZBID}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: g.NZBName ?? "Unknown",
        state,
        progress: sizeBytes > 0 ? (sizeBytes - leftBytes) / sizeBytes : 0,
        sizeBytes,
        sizeLeftBytes: leftBytes,
        speedBps,
        etaSeconds: speedBps ? Math.round(leftBytes / speedBps) : undefined,
        category: g.Category || undefined,
      };
    });
  },
};
