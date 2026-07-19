import type { IntegrationAdapter, IntegrationConfig, SkyReading } from "../types.js";
import { fetchRaw, joinUrl } from "../types.js";

/**
 * SQM — Sky Quality Meter collector & API. Talks to the companion `sqm`
 * container (which polls a Unihedron SQM-LE over TCP and stores readings),
 * *not* to the meter directly. That service exposes a read-only, API-key-gated
 * JSON API:
 *
 *   GET /health          — open; device reachability + last-reading age
 *   GET /api/latest      — key; most recent reading
 *   GET /api/readings    — key; history (?hours=N&order=asc&limit=…)
 *
 * Auth is a shared key sent as `X-API-Key`. Nothing here is specific to one
 * deployment — point the Internal URL at your own `sqm` service and paste your
 * own key. Sky brightness is `mpsas` (magnitudes per square arcsecond): higher
 * is darker, ~22 pristine, ~18 suburban, 0.00 during the day.
 */

interface SqmReading {
  ts: number;
  mpsas: number;
  frequency_hz?: number;
  temperature_c?: number;
}

/** GET a key-protected SQM endpoint, mapping auth failures to a clear message. */
async function sqmGet<T>(cfg: IntegrationConfig, path: string, timeoutMs = 8000): Promise<T> {
  const res = await fetchRaw(
    joinUrl(cfg.url, path),
    { headers: { "X-API-Key": cfg.secrets.apiKey ?? "" } },
    timeoutMs
  );
  const host = new URL(cfg.url).host;
  if (res.status === 401 || res.status === 403)
    throw new Error(`${host} rejected the API key (${res.status}) — check the SQM API key`);
  if (res.status === 404) throw new Error("no_readings"); // sentinel: reachable, but nothing stored yet
  if (!res.ok) throw new Error(`SQM HTTP ${res.status} from ${host}`);
  return (await res.json()) as T;
}

function toMs(ts: number): number {
  // the API reports `ts` as unix epoch seconds (float); normalise to ms
  return ts > 1e12 ? ts : ts * 1000;
}

/** Even-stride downsample so the sparkline stays light regardless of window. */
function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  const last = rows[rows.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export const sqm: IntegrationAdapter = {
  type: "sqm",
  label: "SQM (Sky Quality)",
  urlPlaceholder: "http://sqm:8080",
  capabilities: ["sky", "status"],
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],

  async test(cfg) {
    const t0 = Date.now();
    // /health is open (no key); confirms the collector is up and the meter's state
    const health = await sqmGet<{
      device_reachable?: boolean;
      last_reading_age_seconds?: number;
      rows?: number;
    }>(cfg, "/health").catch(() => null);
    // /api/latest proves the API key is accepted (404 = up but no readings yet)
    let latest: SqmReading | null = null;
    try {
      latest = await sqmGet<SqmReading>(cfg, "/api/latest");
    } catch (err: any) {
      if (err?.message !== "no_readings") throw err;
    }

    const latencyMs = Date.now() - t0;
    if (health?.device_reachable === false)
      return { ok: true, latencyMs, message: "API up, but the meter is unreachable" };
    if (!latest) return { ok: true, latencyMs, message: "API up — no readings stored yet" };
    return { ok: true, latencyMs, message: `Latest ${latest.mpsas.toFixed(2)} mag/arcsec²` };
  },

  async fetchSky(cfg, windowHours) {
    const latest = await sqmGet<SqmReading>(cfg, "/api/latest").catch((err: any) => {
      if (err?.message === "no_readings") return null; // meter online but DB empty
      throw err;
    });
    if (!latest) return null;

    // History over the window drives both the sparkline and the "darkest" figure.
    // Tolerate a missing/failed history endpoint — the current reading still shows.
    // The API may return a bare array or wrap it ({readings|data|items}); accept both.
    const hours = Math.max(1, Math.min(168, Math.round(windowHours) || 12));
    const payload = await sqmGet<
      SqmReading[] | { readings?: SqmReading[]; data?: SqmReading[]; items?: SqmReading[] }
    >(cfg, `/api/readings?hours=${hours}&order=asc&limit=5000`).catch(() => [] as SqmReading[]);
    const rows: SqmReading[] = Array.isArray(payload)
      ? payload
      : (payload.readings ?? payload.data ?? payload.items ?? []);

    const darkest = rows.reduce((m, r) => (r.mpsas > m ? r.mpsas : m), 0);
    const history = downsample(rows, 80).map((r) => ({ at: toMs(r.ts), mpsas: r.mpsas }));

    const reading: SkyReading = {
      source: { id: cfg.id, type: cfg.type, name: cfg.name },
      mpsas: latest.mpsas,
      temperatureC: Number.isFinite(latest.temperature_c) ? latest.temperature_c : undefined,
      frequencyHz: Number.isFinite(latest.frequency_hz) ? latest.frequency_hz : undefined,
      at: toMs(latest.ts),
      windowHours: hours,
      darkestMpsas: darkest > 0 ? darkest : undefined,
      history: history.length > 1 ? history : undefined,
    };
    return reading;
  },

  async fetchSkyReadings(cfg, sinceSec, untilSec, limit) {
    try {
      const payload = await sqmGet<
        SqmReading[] | { readings?: SqmReading[]; data?: SqmReading[]; items?: SqmReading[] }
      >(
        cfg,
        `/api/readings?since=${Math.floor(sinceSec)}&until=${Math.ceil(untilSec)}&order=asc&limit=${limit}`
      );
      const rows: SqmReading[] = Array.isArray(payload)
        ? payload
        : (payload.readings ?? payload.data ?? payload.items ?? []);
      return rows
        .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.mpsas))
        .map((r) => ({ ts: r.ts, mpsas: r.mpsas }));
    } catch (err: any) {
      if (err?.message === "no_readings") return []; // window simply has no rows
      throw err;
    }
  },
};
