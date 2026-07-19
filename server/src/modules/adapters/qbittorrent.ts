import type {
  DownloadItem,
  DownloadState,
  IntegrationAdapter,
  IntegrationConfig,
} from "../types.js";
import { fetchRaw, joinUrl } from "../types.js";

/**
 * qBittorrent WebUI API v2. Auth is cookie-based; we cache the SID per
 * integration and re-login transparently when it expires.
 */

const sessions = new Map<number, string>();

async function login(cfg: IntegrationConfig): Promise<string> {
  const res = await fetchRaw(joinUrl(cfg.url, "/api/v2/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: cfg.secrets.username ?? "",
      password: cfg.secrets.password ?? "",
    }),
  });
  const cookie = res.headers.get("set-cookie");
  const sid = cookie?.match(/SID=([^;]+)/)?.[1];
  if (!res.ok || !sid) throw new Error("qBittorrent login failed — check username/password");
  sessions.set(cfg.id, sid);
  return sid;
}

async function authedGet(cfg: IntegrationConfig, path: string): Promise<Response> {
  let sid = sessions.get(cfg.id) ?? (await login(cfg));
  let res = await fetchRaw(joinUrl(cfg.url, path), { headers: { Cookie: `SID=${sid}` } });
  if (res.status === 403) {
    sid = await login(cfg);
    res = await fetchRaw(joinUrl(cfg.url, path), { headers: { Cookie: `SID=${sid}` } });
  }
  if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`);
  return res;
}

/** POST a form body to a WebUI endpoint, re-logging in once on a 403. */
async function authedPost(
  cfg: IntegrationConfig,
  path: string,
  form: Record<string, string>
): Promise<Response> {
  const send = (sid: string) =>
    fetchRaw(joinUrl(cfg.url, path), {
      method: "POST",
      headers: {
        Cookie: `SID=${sid}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    });
  let sid = sessions.get(cfg.id) ?? (await login(cfg));
  let res = await send(sid);
  if (res.status === 403) {
    sid = await login(cfg);
    res = await send(sid);
  }
  return res;
}

/** qBittorrent 5.0 renamed pause/resume → stop/start; try new name, fall back. */
async function pauseResume(cfg: IntegrationConfig, hash: string, resume: boolean): Promise<void> {
  const [modern, legacy] = resume ? ["start", "resume"] : ["stop", "pause"];
  let res = await authedPost(cfg, `/api/v2/torrents/${modern}`, { hashes: hash });
  if (res.status === 404)
    res = await authedPost(cfg, `/api/v2/torrents/${legacy}`, { hashes: hash });
  if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`);
}

function mapState(state: string): DownloadState {
  switch (state) {
    case "pausedDL":
    case "stoppedDL":
      return "paused";
    case "queuedDL":
    case "allocating":
      return "queued";
    case "error":
    case "missingFiles":
      return "error";
    case "uploading":
    case "stalledUP":
    case "queuedUP":
    case "pausedUP":
    case "stoppedUP":
    case "forcedUP":
      return "completed";
    default:
      return "downloading"; // downloading, stalledDL, metaDL, checkingDL, forcedDL
  }
}

export const qbittorrent: IntegrationAdapter = {
  type: "qbittorrent",
  label: "qBittorrent",
  urlPlaceholder: "http://qbittorrent:8081",
  capabilities: ["queue", "status"],
  fields: [
    { key: "username", label: "WebUI username", type: "text", required: true },
    { key: "password", label: "WebUI password", type: "password", required: true },
  ],

  async test(cfg) {
    const t0 = Date.now();
    const res = await authedGet(cfg, "/api/v2/app/version");
    return { ok: true, latencyMs: Date.now() - t0, version: (await res.text()).trim() };
  },

  queueActions: ["pause", "resume", "remove", "priorityUp", "priorityDown"],

  async runQueueAction(cfg, hash, action) {
    switch (action) {
      case "pause":
        return pauseResume(cfg, hash, false);
      case "resume":
        return pauseResume(cfg, hash, true);
      case "remove": {
        const res = await authedPost(cfg, "/api/v2/torrents/delete", {
          hashes: hash,
          deleteFiles: "false",
        });
        if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`);
        return;
      }
      case "priorityUp":
      case "priorityDown": {
        const ep = action === "priorityUp" ? "increasePrio" : "decreasePrio";
        const res = await authedPost(cfg, `/api/v2/torrents/${ep}`, { hashes: hash });
        if (res.status === 409)
          throw new Error("Enable qBittorrent's torrent queueing to reprioritise");
        if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`);
        return;
      }
    }
  },

  async fetchQueue(cfg) {
    // "downloading" filter = every torrent that hasn't finished (incl. paused/stalled/queued)
    const res = await authedGet(cfg, "/api/v2/torrents/info?filter=downloading");
    const torrents: any[] = await res.json();
    return torrents.map((t): DownloadItem => {
      const size = Number(t.size) || 0;
      const progress = Number(t.progress) || 0;
      return {
        id: `qbittorrent-${cfg.id}-${t.hash}`,
        source: { id: cfg.id, type: cfg.type, name: cfg.name },
        title: t.name,
        state: mapState(t.state),
        progress,
        sizeBytes: size,
        sizeLeftBytes: Number(t.amount_left) || Math.round(size * (1 - progress)),
        speedBps: Number(t.dlspeed) || undefined,
        etaSeconds: t.eta && t.eta < 8_640_000 ? Number(t.eta) : undefined,
        category: t.category || undefined,
      };
    });
  },
};
