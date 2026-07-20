import { db } from "./db.js";
import { getAdapter } from "./modules/registry.js";
import { listIntegrations, rowToConfig } from "./routes/integrations.js";
import { fetchRaw } from "./modules/types.js";
import { notify } from "./lib/notify.js";
import { checkAllMonitors } from "./lib/siteChecker.js";
import { formatFinishedDownload } from "./lib/downloadNotification.js";

/**
 * Server-side watcher that turns state changes into notifications. Runs on an
 * interval and is deliberately conservative: it seeds state on the first pass
 * (no alerts on boot) and only emits on genuine transitions.
 */

const INTERVAL_MS = 60_000;
const DISK_WARN_PCT = 90;
const DISK_DEDUPE_MS = 6 * 60 * 60 * 1000; // re-warn about the same full disk at most every 6h
const DONE_PROGRESS = 0.9; // an item that vanishes above this counts as finished

interface TrackedDownload {
  title: string;
  /** SxxEyy for episodes (Sonarr), when known */
  episode?: string;
  /** episode / track / book title — the secondary line the widget shows */
  subtitle?: string;
  progress: number;
  client: string;
  clientType: string;
  sizeBytes: number;
  category?: string;
  externalIds?: { imdb?: string; tvdb?: number; tmdb?: number };
}

const serviceUp = new Map<string, boolean>();
const prevDownloads = new Map<string, TrackedDownload>();
// media-id → requester emails, refreshed each tick from request managers (Jellyseerr)
const requestIndex = new Map<string, Set<string>>();
let running = false;
let startTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

/** Pull current requests from every request-manager integration and index them
 *  by media id, so a finished grab can be attributed to whoever asked for it. */
async function refreshRequestIndex(): Promise<void> {
  const sources = listIntegrations().filter((r) => getAdapter(r.type)?.fetchRequests);
  if (sources.length === 0) {
    requestIndex.clear();
    return;
  }
  const next = new Map<string, Set<string>>();
  const add = (key: string, email: string) => {
    if (!next.has(key)) next.set(key, new Set());
    next.get(key)!.add(email);
  };
  await Promise.all(
    sources.map(async (row) => {
      try {
        const reqs = await getAdapter(row.type)!.fetchRequests!(rowToConfig(row));
        for (const r of reqs) {
          if (r.tvdbId) add(`tvdb:${r.tvdbId}`, r.requestedByEmail);
          if (r.tmdbId) add(`tmdb:${r.tmdbId}`, r.requestedByEmail);
        }
      } catch {
        /* a flaky request manager shouldn't wipe the whole index */
      }
    })
  );
  requestIndex.clear();
  for (const [k, v] of next) requestIndex.set(k, v);
}

/** Emails that requested a given item, by its media ids ([] = unattributed). */
function resolveRequesters(ids?: TrackedDownload["externalIds"]): string[] {
  if (!ids) return [];
  const out = new Set<string>();
  if (ids.tvdb) for (const e of requestIndex.get(`tvdb:${ids.tvdb}`) ?? []) out.add(e);
  if (ids.tmdb) for (const e of requestIndex.get(`tmdb:${ids.tmdb}`) ?? []) out.add(e);
  return [...out];
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const v = bytes / 2 ** (i * 10);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

async function checkServices(): Promise<void> {
  const integrations = listIntegrations("status");
  const tabs = db.prepare("SELECT id, name, url FROM tabs WHERE ping = 1").all() as Array<{
    id: number;
    name: string;
    url: string;
  }>;

  const states: Array<{ key: string; name: string; up: boolean }> = [];

  await Promise.all(
    integrations.map(async (row) => {
      let up: boolean;
      try {
        await getAdapter(row.type)!.test(rowToConfig(row));
        up = true;
      } catch {
        up = false;
      }
      states.push({ key: `int:${row.id}`, name: row.name, up });
    })
  );
  await Promise.all(
    tabs.map(async (tab) => {
      let up: boolean;
      try {
        await fetchRaw(tab.url, { method: "GET", redirect: "manual" }, 6000, { discardBody: true });
        up = true; // any HTTP answer means it's reachable
      } catch {
        up = false;
      }
      states.push({ key: `tab:${tab.id}`, name: tab.name, up });
    })
  );

  for (const s of states) {
    const prev = serviceUp.get(s.key);
    serviceUp.set(s.key, s.up);
    if (prev === undefined || prev === s.up) continue; // first sight or no change
    if (s.up)
      await notify({
        kind: "success",
        category: "services",
        title: `${s.name} recovered`,
        body: `${s.name} is reachable again.`,
        fields: [{ label: "Service", value: s.name }],
      });
    else
      await notify({
        kind: "error",
        category: "services",
        title: `${s.name} is down`,
        body: `${s.name} stopped responding.`,
        fields: [{ label: "Service", value: s.name }],
      });
  }
}

async function checkDisks(): Promise<void> {
  const rows = listIntegrations().filter((r) => getAdapter(r.type)?.fetchSystems);
  for (const row of rows) {
    let hosts;
    try {
      hosts = await getAdapter(row.type)!.fetchSystems!(rowToConfig(row));
    } catch {
      continue;
    }
    for (const h of hosts) {
      if (h.status === "up" && h.diskPct != null && h.diskPct >= DISK_WARN_PCT) {
        await notify({
          kind: "warn",
          category: "disk",
          title: `Low disk on ${h.name}`,
          body: `Disk usage on ${h.name} has reached ${Math.round(h.diskPct)}%.`,
          fields: [
            { label: "Host", value: h.name },
            { label: "Disk", value: `${Math.round(h.diskPct)}%` },
            ...(h.memPct != null ? [{ label: "Memory", value: `${Math.round(h.memPct)}%` }] : []),
            ...(h.cpuPct != null ? [{ label: "CPU", value: `${Math.round(h.cpuPct)}%` }] : []),
          ],
          eventKey: `disk:${row.id}:${h.name}`,
          dedupeMs: DISK_DEDUPE_MS,
        });
      }
    }
  }
}

async function checkDownloads(): Promise<void> {
  const rows = listIntegrations("downloads").filter((r) => getAdapter(r.type)?.fetchQueue);
  const current = new Map<string, TrackedDownload>();
  const responded = new Set<number>();

  await Promise.all(
    rows.map(async (row) => {
      const adapter = getAdapter(row.type)!;
      try {
        const items = await adapter.fetchQueue!(rowToConfig(row));
        responded.add(row.id);
        for (const it of items)
          current.set(it.id, {
            title: it.title,
            episode: it.episode,
            subtitle: it.subtitle,
            progress: it.progress,
            client: it.source.name,
            clientType: adapter.label,
            sizeBytes: it.sizeBytes,
            category: it.category,
            externalIds: it.externalIds,
          });
      } catch {
        /* leave this source out of the diff so a blip isn't read as "finished" */
      }
    })
  );

  for (const [id, prev] of prevDownloads) {
    const srcId = Number(id.split("-")[1]);
    // only judge sources that answered this pass, and only near-complete items
    if (responded.has(srcId) && !current.has(id) && prev.progress >= DONE_PROGRESS) {
      const message = formatFinishedDownload(prev);
      await notify({
        kind: "success",
        category: "downloads",
        title: message.title,
        body: message.body,
        fields: [
          { label: prev.episode ? "Series" : "Title", value: prev.title },
          ...(prev.episode ? [{ label: "Episode", value: prev.episode }] : []),
          ...(prev.subtitle
            ? [{ label: prev.episode ? "Episode title" : "Item", value: prev.subtitle }]
            : []),
          { label: "Client", value: `${prev.client} (${prev.clientType})` },
          { label: "Size", value: formatBytes(prev.sizeBytes) },
          ...(prev.category ? [{ label: "Category", value: prev.category }] : []),
        ],
        // whoever requested it (via a request manager) — powers "only my requests"
        requesterEmails: resolveRequesters(prev.externalIds),
        eventKey: `done:${id}`,
        dedupeMs: 60 * 60 * 1000,
      });
    }
  }
  // replace only the sources that responded; keep last-known items for the rest
  for (const id of [...prevDownloads.keys()]) {
    if (responded.has(Number(id.split("-")[1]))) prevDownloads.delete(id);
  }
  for (const [id, v] of current) prevDownloads.set(id, v);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // requests first so a download finishing this tick can be attributed
    await refreshRequestIndex();
    await Promise.allSettled([checkServices(), checkDisks(), checkDownloads(), checkAllMonitors()]);
  } finally {
    running = false;
  }
}

export function startMonitor(): () => void {
  // small delay so the DB/routes are warm; then poll on the interval
  startTimer = setTimeout(() => {
    void tick();
    intervalTimer = setInterval(() => void tick(), INTERVAL_MS);
    intervalTimer.unref?.();
  }, 5_000);
  startTimer.unref?.();
  return stopMonitor;
}

export function stopMonitor(): void {
  if (startTimer) clearTimeout(startTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startTimer = null;
  intervalTimer = null;
}
