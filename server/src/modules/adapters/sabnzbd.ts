import type {
  DownloadItem,
  DownloadState,
  IntegrationAdapter,
  IntegrationConfig,
} from "../types.js";
import { fetchJson, joinUrl } from "../types.js";

function api(url: string, apiKey: string, mode: string): string {
  return joinUrl(url, `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(apiKey)}`);
}

/** Run a queue sub-command (pause/resume/delete) against one nzo id. */
async function queueCmd(
  cfg: IntegrationConfig,
  name: string,
  nzo: string,
  extra = ""
): Promise<void> {
  const key = cfg.secrets.apiKey ?? "";
  const url = api(cfg.url, key, "queue") + `&name=${name}&value=${encodeURIComponent(nzo)}${extra}`;
  const data = await fetchJson<any>(url);
  if (data.error) throw new Error(data.error);
  if (data.status === false) throw new Error(`SABnzbd rejected ${name}`);
}

function mapState(status: string): DownloadState {
  switch (status?.toLowerCase()) {
    case "paused":
      return "paused";
    case "queued":
    case "grabbing":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    default:
      return "downloading";
  }
}

function parseTimeleft(t?: string): number | undefined {
  if (!t) return undefined;
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export const sabnzbd: IntegrationAdapter = {
  type: "sabnzbd",
  label: "SABnzbd",
  urlPlaceholder: "http://sabnzbd:8080",
  capabilities: ["queue", "status"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    const data = await fetchJson<any>(api(cfg.url, cfg.secrets.apiKey ?? "", "version"));
    if (data.error) throw new Error(data.error);
    return { ok: true, latencyMs: Date.now() - t0, version: data.version };
  },

  queueActions: ["pause", "resume", "remove"],

  async runQueueAction(cfg, nzo, action) {
    if (action === "pause") return queueCmd(cfg, "pause", nzo);
    if (action === "resume") return queueCmd(cfg, "resume", nzo);
    if (action === "remove") return queueCmd(cfg, "delete", nzo, "&del_files=0");
    // SABnzbd has no simple up/down reprioritise via a single nzo id
  },

  async fetchQueue(cfg) {
    const data = await fetchJson<any>(api(cfg.url, cfg.secrets.apiKey ?? "", "queue"));
    if (data.error) throw new Error(data.error);
    const q = data.queue ?? {};
    const globalSpeed = (Number(q.kbpersec) || 0) * 1024;
    const slots: any[] = q.slots ?? [];
    return slots.map((s, i): DownloadItem => {
      const sizeBytes = (Number(s.mb) || 0) * 1024 * 1024;
      const leftBytes = (Number(s.mbleft) || 0) * 1024 * 1024;
      const state = mapState(s.status);
      return {
        id: `sabnzbd-${cfg.id}-${s.nzo_id}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: s.filename,
        state,
        progress: sizeBytes > 0 ? (sizeBytes - leftBytes) / sizeBytes : 0,
        sizeBytes,
        sizeLeftBytes: leftBytes,
        // SAB downloads sequentially: the active (first non-paused) slot gets the global speed
        speedBps: i === 0 && state === "downloading" ? globalSpeed : undefined,
        etaSeconds: parseTimeleft(s.timeleft),
        category: s.cat !== "*" ? s.cat : undefined,
      };
    });
  },
};
