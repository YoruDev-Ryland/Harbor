import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db.js";
import { requirePerm } from "../auth/auth.js";
import type { User } from "../auth/auth.js";
import { getAdapter } from "../modules/registry.js";
import { listIntegrationsForUser, rowToConfig } from "./integrations.js";
import { canSee } from "./tabs.js";
import { moduleAccessScope, requireWidget } from "../lib/moduleAccess.js";
import { fetchRaw } from "../modules/types.js";
import { resolvePlexItemUrl } from "../modules/adapters/plex.js";
import { hasOnlyKeys, isPlainRecord } from "../auth/validation.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import type {
  CalendarEvent,
  ContainerInfo,
  DownloadItem,
  HostMetric,
  IndexerStatus,
  NowPlayingSession,
  ProgressItem,
  RecentItem,
  ScopeStatus,
  SkyReading,
  StorageMount,
  QueueAction,
} from "../modules/types.js";

/** tiny TTL cache so widget polling doesn't hammer the integrations */
const cache = new Map<string, { at: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  if (inFlight.size >= 500) throw new Error("widget request budget exhausted");
  const work = fn()
    .then((data) => {
      if (cache.size >= 500) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
        for (const [oldKey] of oldest) cache.delete(oldKey);
      }
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

function imageMagicType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  const six = buf.subarray(0, 6).toString("ascii");
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

async function sendSafeImage(reply: FastifyReply, upstream: Response, maxAge: number) {
  if (!upstream.ok) return reply.code(502).send({ error: `image HTTP ${upstream.status}` });
  const declared = (upstream.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!IMAGE_TYPES.has(declared))
    return reply.code(415).send({ error: "upstream did not return an allowed raster image" });
  const buf = Buffer.from(await upstream.arrayBuffer());
  const detected = imageMagicType(buf);
  if (!detected || detected !== declared)
    return reply
      .code(415)
      .send({ error: "upstream image content did not match its declared type" });
  return reply
    .header("content-type", detected)
    .header("content-length", String(buf.length))
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", `private, max-age=${maxAge}`)
    .send(buf);
}

interface SourceError {
  source: { id: number; type: string; name: string };
  message: string;
}

function publicError(user: User, error: any, fallback: string): string {
  return user.permissions.manageIntegrations ? (error?.message ?? fallback) : fallback;
}

// Night-sky heatmap aggregation. We keep 30-minute buckets per integration+year
// in memory and only pull readings newer than we've already seen, so the first
// request backfills the year (in chunks) and every later poll fetches just the
// handful of new readings — the graph "fills in" without re-reading the year.
const HEAT_BUCKET_SEC = 1800;
const HEAT_CHUNK_SEC = 14 * 86_400;
// Keep each SQM JSON response comfortably below the global 4 MiB outbound
// ceiling. A full chunk may contain more rows, so capped pages continue from
// the latest returned timestamp instead of skipping the rest of the chunk.
const HEAT_PAGE_LIMIT = 10_000;
interface HeatState {
  lastTs: number;
  touchedAt: number;
  buckets: Map<number, { sum: number; count: number }>;
}
const heatStates = new Map<string, HeatState>();
/** earliest reading epoch-seconds per integration id (for the year selector) */
const heatEarliest = new Map<number, number>();

/** Fan out the release calendar across every calendar-capable integration. */
export async function gatherCalendar(
  startIso: string,
  endIso: string,
  unmonitored: boolean,
  user: User
): Promise<{ events: CalendarEvent[]; errors: SourceError[] }> {
  const rows = listIntegrationsForUser(user, "calendar").filter(
    (r) => getAdapter(r.type)?.fetchCalendar
  );
  const errors: SourceError[] = [];
  const results = await Promise.all(
    rows.map(async (row): Promise<CalendarEvent[]> => {
      try {
        return await getAdapter(row.type)!.fetchCalendar!(rowToConfig(row), startIso, endIso, {
          unmonitored,
        });
      } catch (err: any) {
        errors.push({
          source: { id: row.id, type: row.type, name: row.name },
          message: publicError(user, err, "fetch failed"),
        });
        return [];
      }
    })
  );
  const events = results.flat().sort((a, b) => a.airDateUtc.localeCompare(b.airDateUtc));
  return { events, errors };
}

export function widgetRoutes(app: FastifyInstance): void {
  // ── unified downloads ─────────────────────────────────────────────
  app.get(
    "/api/widgets/downloads",
    { preHandler: requireWidget("downloads", "stats") },
    async (req) =>
      cached(`downloads:${moduleAccessScope(req.user!)}`, 4000, async () => {
        const rows = listIntegrationsForUser(req.user!, "downloads").filter(
          (r) => getAdapter(r.type)?.fetchQueue
        );
        const errors: SourceError[] = [];
        const results = await Promise.all(
          rows.map(async (row): Promise<DownloadItem[]> => {
            const adapter = getAdapter(row.type)!;
            try {
              const items = await adapter.fetchQueue!(rowToConfig(row));
              const actions = adapter.runQueueAction ? (adapter.queueActions ?? []) : [];
              return actions.length ? items.map((i) => ({ ...i, actions })) : items;
            } catch (err: any) {
              errors.push({
                source: { id: row.id, type: row.type, name: row.name },
                message: publicError(req.user!, err, "fetch failed"),
              });
              return [];
            }
          })
        );
        const items = results
          .flat()
          .sort((a, b) => stateRank(a.state) - stateRank(b.state) || b.progress - a.progress);
        const totalSpeedBps = items.reduce((sum, i) => sum + (i.speedBps ?? 0), 0);
        return {
          items,
          errors,
          totalSpeedBps,
          sources: rows.map((r) => ({ id: r.id, type: r.type, name: r.name })),
        };
      })
  );

  // ── download item actions ─────────────────────────────────────────
  app.post<{ Body: { id?: string; action?: QueueAction } }>(
    "/api/widgets/downloads/action",
    { preHandler: [requireWidget("downloads"), requirePerm("controlDownloads")] },
    async (req, reply) => {
      if (!hasOnlyKeys(req.body ?? {}, ["id", "action"]))
        return reply.code(400).send({ error: "bad request" });
      const { id, action } = req.body ?? {};
      // item ids are `${type}-${cfgId}-${nativeId}`; nativeId may contain dashes
      const m = /^([a-z]+)-(\d+)-(.+)$/.exec(id ?? "");
      if (!m || !action) return reply.code(400).send({ error: "bad request" });
      const [, type, cfgIdStr, nativeId] = m;
      const row = listIntegrationsForUser(req.user!, "downloads").find(
        (r) => r.id === Number(cfgIdStr) && r.type === type
      );
      const adapter = row && getAdapter(row.type);
      if (!row || !adapter?.runQueueAction)
        return reply.code(404).send({ error: "no such download source" });
      if (!adapter.queueActions?.includes(action))
        return reply.code(400).send({ error: `${adapter.label} can't ${action}` });
      try {
        await adapter.runQueueAction(rowToConfig(row), nativeId, action);
        cache.delete(`downloads:${moduleAccessScope(req.user!)}`); // next poll returns fresh queue state
        return { ok: true };
      } catch (err: any) {
        return reply.code(502).send({ error: publicError(req.user!, err, "action failed") });
      }
    }
  );

  // ── release calendar ──────────────────────────────────────────────
  app.get<{ Querystring: { start?: string; end?: string; unmonitored?: string } }>(
    "/api/widgets/calendar",
    { preHandler: requireWidget("calendar") },
    async (req, reply) => {
      const start = req.query.start ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
      const end = req.query.end ?? new Date(Date.now() + 14 * 86_400_000).toISOString();
      if (req.query.unmonitored !== undefined && !["true", "false"].includes(req.query.unmonitored))
        return reply.code(400).send({ error: "unmonitored must be true or false" });
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs ||
        endMs - startMs > 370 * 86_400_000
      )
        return reply.code(400).send({ error: "calendar range must be valid and at most 370 days" });
      const unmonitored = req.query.unmonitored !== "false";
      return cached(
        `calendar:${moduleAccessScope(req.user!)}:${start}:${end}:${unmonitored}`,
        60_000,
        async () => ({
          ...(await gatherCalendar(start, end, unmonitored, req.user!)),
          start,
          end,
        })
      );
    }
  );

  // Minimal browser-facing source inventory for calendar deep links. Full
  // integration configuration remains restricted to integration managers.
  app.get("/api/widgets/calendar/sources", { preHandler: requireWidget("calendar") }, async (req) =>
    listIntegrationsForUser(req.user!, "calendar").map((row) => ({
      id: row.id,
      url: normalizeHttpUrl(row.public_url, true) ?? "",
    }))
  );

  // ── now playing (active streams) ──────────────────────────────────
  app.get("/api/widgets/nowplaying", { preHandler: requireWidget("nowplaying") }, async (req) =>
    cached(`nowplaying:${moduleAccessScope(req.user!)}`, 5000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchNowPlaying
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<NowPlayingSession[]> => {
          try {
            return await getAdapter(row.type)!.fetchNowPlaying!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "fetch failed"),
            });
            return [];
          }
        })
      );
      const sessions = dedupeNowPlaying(results.flat()).sort(
        (a, b) => stateRank2(a.state) - stateRank2(b.state)
      );
      return { sessions, errors };
    })
  );

  // Poster/thumb proxy — keeps the source's token server-side and works even
  // when the browser can't reach the internal service URL.
  app.get<{ Querystring: { source?: string; path?: string } }>(
    "/api/widgets/nowplaying/art",
    { preHandler: requireWidget("nowplaying", "recent") },
    async (req, reply) => {
      const id = Number(req.query.source);
      const path = req.query.path ?? "";
      if (!Number.isSafeInteger(id) || id < 1 || typeof path !== "string" || path.length > 2_048)
        return reply.code(400).send({ error: "invalid art request" });
      const row = listIntegrationsForUser(req.user!).find((r) => r.id === id);
      const adapter = row && getAdapter(row.type);
      if (!row || !adapter?.fetchArt) return reply.code(404).send({ error: "no art source" });
      try {
        const upstream = await adapter.fetchArt(rowToConfig(row), path);
        if (!upstream.ok) return reply.code(502).send({ error: `art HTTP ${upstream.status}` });
        return await sendSafeImage(reply, upstream, 120);
      } catch (err: any) {
        return reply.code(502).send({ error: publicError(req.user!, err, "art fetch failed") });
      }
    }
  );

  // ── system / host metrics ─────────────────────────────────────────
  app.get("/api/widgets/system", { preHandler: requireWidget("system") }, async (req) =>
    cached(`system:${moduleAccessScope(req.user!)}`, 8000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchSystems
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<HostMetric[]> => {
          try {
            return await getAdapter(row.type)!.fetchSystems!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "fetch failed"),
            });
            return [];
          }
        })
      );
      const hosts = results
        .flat()
        .sort((a, b) => hostRank(a.status) - hostRank(b.status) || a.name.localeCompare(b.name));
      return { hosts, errors };
    })
  );

  // ── Plex deep-link resolver ───────────────────────────────────────
  app.post<{ Body: CalendarEvent }>(
    "/api/widgets/plex/resolve",
    { preHandler: requireWidget("calendar") },
    async (req, reply) => {
      if (
        !hasOnlyKeys(req.body, [
          "id",
          "source",
          "title",
          "subtitle",
          "episode",
          "airDateUtc",
          "allDay",
          "state",
          "kind",
          "isAnime",
          "externalIds",
        ]) ||
        typeof req.body.title !== "string" ||
        !req.body.title.trim() ||
        req.body.title.length > 512 ||
        (req.body.kind !== "movie" && req.body.kind !== "episode") ||
        !isPlainRecord(req.body.source) ||
        !Number.isInteger(req.body.source.id)
      )
        return reply.code(400).send({ error: "invalid calendar event" });
      const row = listIntegrationsForUser(req.user!).find((r) => r.type === "plex");
      if (!row) return reply.code(404).send({ error: "No enabled Plex integration" });
      try {
        const url = await resolvePlexItemUrl(rowToConfig(row), row.public_url || row.url, req.body);
        if (!url) return reply.code(404).send({ error: "Plex item not found" });
        return { url };
      } catch (err: any) {
        return reply.code(502).send({ error: publicError(req.user!, err, "Plex lookup failed") });
      }
    }
  );

  // ── indexers (Prowlarr) ───────────────────────────────────────────
  app.get("/api/widgets/indexers", { preHandler: requireWidget("indexers") }, async (req) =>
    cached(`indexers:${moduleAccessScope(req.user!)}`, 30_000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchIndexers
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<IndexerStatus[]> => {
          try {
            return await getAdapter(row.type)!.fetchIndexers!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "failed"),
            });
            return [];
          }
        })
      );
      const indexers = results
        .flat()
        .sort((a, b) => Number(a.up) - Number(b.up) || a.name.localeCompare(b.name));
      return { indexers, errors };
    })
  );

  // ── containers (Portainer, read-only) ─────────────────────────────
  app.get("/api/widgets/containers", { preHandler: requireWidget("containers") }, async (req) =>
    cached(`containers:${moduleAccessScope(req.user!)}`, 15_000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchContainers
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<ContainerInfo[]> => {
          try {
            return await getAdapter(row.type)!.fetchContainers!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "failed"),
            });
            return [];
          }
        })
      );
      // down first (needs attention), then unhealthy, then healthy
      const rank = (c: ContainerInfo) => (!c.up ? 0 : c.health === "unhealthy" ? 1 : 2);
      const containers = results
        .flat()
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      return { containers, errors };
    })
  );

  // ── continue: reading/listening progress (Audiobookshelf, Kavita) ──
  app.get("/api/widgets/progress", { preHandler: requireWidget("continue") }, async (req) =>
    cached(`progress:${moduleAccessScope(req.user!)}`, 30_000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchProgress
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<ProgressItem[]> => {
          try {
            return await getAdapter(row.type)!.fetchProgress!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "failed"),
            });
            return [];
          }
        })
      );
      const items = results.flat().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return { items, errors, configured: rows.length };
    })
  );

  // ── recently added (poster wall, Plex/Tautulli) ───────────────────
  app.get("/api/widgets/recent", { preHandler: requireWidget("recent") }, async (req) =>
    cached(`recent:${moduleAccessScope(req.user!)}`, 60_000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchRecentlyAdded
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<RecentItem[]> => {
          try {
            return await getAdapter(row.type)!.fetchRecentlyAdded!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "failed"),
            });
            return [];
          }
        })
      );
      const items = dedupeRecent(results.flat())
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        .slice(0, 24);
      return { items, errors };
    })
  );

  // ── storage (free-space bars, the *arrs + Beszel) ─────────────────
  app.get("/api/widgets/storage", { preHandler: requireWidget("storage") }, async (req) =>
    cached(`storage-mounts:${moduleAccessScope(req.user!)}`, 60_000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter(
        (r) => getAdapter(r.type)?.fetchStorage
      );
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<StorageMount[]> => {
          try {
            return await getAdapter(row.type)!.fetchStorage!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "failed"),
            });
            return [];
          }
        })
      );
      const mounts = dedupeMounts(results.flat()).sort(
        (a, b) => b.usedPct - a.usedPct || a.label.localeCompare(b.label)
      );
      return { mounts, errors };
    })
  );

  // ── sky quality (SQM meters) ──────────────────────────────────────
  app.get<{ Querystring: { hours?: string } }>(
    "/api/widgets/sky",
    { preHandler: requireWidget("sky") },
    async (req, reply) => {
      const hours = req.query.hours === undefined ? 12 : Number(req.query.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        return reply.code(400).send({ error: "hours must be an integer from 1 through 168" });
      return cached(`sky:${moduleAccessScope(req.user!)}:${hours}`, 30_000, async () => {
        const rows = listIntegrationsForUser(req.user!).filter((r) => getAdapter(r.type)?.fetchSky);
        const errors: SourceError[] = [];
        const results = await Promise.all(
          rows.map(async (row): Promise<SkyReading | null> => {
            try {
              return await getAdapter(row.type)!.fetchSky!(rowToConfig(row), hours);
            } catch (err: any) {
              errors.push({
                source: { id: row.id, type: row.type, name: row.name },
                message: publicError(req.user!, err, "failed"),
              });
              return null;
            }
          })
        );
        const readings = results.filter((r): r is SkyReading => r !== null);
        return { readings, errors, configured: rows.length };
      });
    }
  );

  // ── night-sky heatmap (SQM, full-year) ────────────────────────────
  app.get<{ Querystring: { year?: string } }>(
    "/api/widgets/sky/heatmap",
    { preHandler: requireWidget("sky", "sky-heatmap") },
    async (req, reply) => {
      const currentYear = new Date().getUTCFullYear();
      const year = req.query.year === undefined ? currentYear : Number(req.query.year);
      if (!Number.isInteger(year) || year < 2000 || year > currentYear + 1)
        return reply.code(400).send({ error: `year must be from 2000 through ${currentYear + 1}` });
      return cached(`sky-heatmap:${moduleAccessScope(req.user!)}:${year}`, 60_000, async () => {
        const rows = listIntegrationsForUser(req.user!).filter(
          (r) => getAdapter(r.type)?.fetchSkyReadings
        );
        const errors: SourceError[] = [];
        // widen the year window by ±12h so viewer-local binning near Jan 1 / Dec 31
        // still has its buckets available on the client.
        const yearStart = Date.UTC(year, 0, 1) / 1000 - 12 * 3600;
        const yearEnd = Date.UTC(year + 1, 0, 1) / 1000 + 12 * 3600;
        const until = Math.min(yearEnd, Date.now() / 1000);

        const merged = new Map<number, { sum: number; count: number }>();
        await Promise.all(
          rows.map(async (row) => {
            const key = `${row.id}:${year}`;
            let st = heatStates.get(key);
            if (!st) {
              if (heatStates.size >= 48) {
                const oldest = [...heatStates.entries()].sort(
                  (a, b) => a[1].touchedAt - b[1].touchedAt
                )[0];
                if (oldest) heatStates.delete(oldest[0]);
              }
              st = { lastTs: yearStart - 1, touchedAt: Date.now(), buckets: new Map() };
              heatStates.set(key, st);
            }
            st.touchedAt = Date.now();
            try {
              const adapter = getAdapter(row.type)!;
              // one-time earliest-reading lookup (asc, limit 1) to bound the year picker
              if (!heatEarliest.has(row.id)) {
                const first = await adapter.fetchSkyReadings!(
                  rowToConfig(row),
                  0,
                  Date.now() / 1000,
                  1
                ).catch(() => []);
                heatEarliest.set(row.id, first.length ? first[0].ts : 0);
              }
              // Pull everything newer than we've seen. Time chunks bound each
              // query, while row pages bound the response body without losing
              // readings when a dense chunk reaches the API limit.
              let from = Math.max(st.lastTs, yearStart);
              const refreshUntil = until - st.lastTs < 60 ? st.lastTs : until;
              while (from < refreshUntil) {
                const to = Math.min(from + HEAT_CHUNK_SEC, refreshUntil);
                const readings = await adapter.fetchSkyReadings!(
                  rowToConfig(row),
                  from,
                  to,
                  HEAT_PAGE_LIMIT
                );
                for (const rd of readings) {
                  if (rd.ts <= st.lastTs || rd.ts < yearStart || rd.ts > yearEnd) continue;
                  const b = Math.floor(rd.ts / HEAT_BUCKET_SEC) * HEAT_BUCKET_SEC;
                  const cell = st.buckets.get(b) ?? { sum: 0, count: 0 };
                  cell.sum += rd.mpsas;
                  cell.count += 1;
                  st.buckets.set(b, cell);
                }
                // A full page may have been truncated by the upstream API.
                // Continue within this time chunk from its last row; otherwise
                // advance through the successfully queried empty/sparse range.
                const lastReturned = readings.reduce(
                  (latest, reading) => Math.max(latest, reading.ts),
                  -Infinity
                );
                const pageWasCapped = readings.length >= HEAT_PAGE_LIMIT;
                if (pageWasCapped && Number.isFinite(lastReturned) && lastReturned > from) {
                  st.lastTs = Math.min(lastReturned, to);
                  from = st.lastTs;
                } else if (pageWasCapped) {
                  // Prevent a malformed/non-advancing upstream page from
                  // trapping the request in an infinite loop.
                  st.lastTs = Math.min(Math.floor(from) + 1, to);
                  from = st.lastTs;
                } else {
                  st.lastTs = to;
                  from = to;
                }
              }
            } catch (err: any) {
              errors.push({
                source: { id: row.id, type: row.type, name: row.name },
                message: publicError(req.user!, err, "failed"),
              });
            }
            for (const [b, c] of st.buckets) {
              const m = merged.get(b) ?? { sum: 0, count: 0 };
              m.sum += c.sum;
              m.count += c.count;
              merged.set(b, m);
            }
          })
        );

        const buckets = [...merged.entries()]
          .map(([t, c]) => ({ t, v: Math.round((c.sum / c.count) * 100) / 100, n: c.count }))
          .sort((a, b) => a.t - b.t);

        const maxYear = new Date().getUTCFullYear();
        let earliest = Infinity;
        for (const row of rows) {
          const e = heatEarliest.get(row.id);
          if (e != null && e > 0) earliest = Math.min(earliest, e);
        }
        const minYear = Number.isFinite(earliest)
          ? Math.min(maxYear, new Date(earliest * 1000).getUTCFullYear())
          : maxYear;
        return {
          year,
          buckets,
          errors,
          configured: rows.length,
          minYear,
          maxYear,
          updatedAt: Date.now(),
        };
      });
    }
  );

  // ── telescope / imaging rig (NINA) ────────────────────────────────
  app.get("/api/widgets/scope", { preHandler: requireWidget("scope") }, async (req) =>
    cached(`scope:${moduleAccessScope(req.user!)}`, 5000, async () => {
      const rows = listIntegrationsForUser(req.user!).filter((r) => getAdapter(r.type)?.fetchScope);
      const errors: SourceError[] = [];
      const results = await Promise.all(
        rows.map(async (row): Promise<ScopeStatus | null> => {
          try {
            return await getAdapter(row.type)!.fetchScope!(rowToConfig(row));
          } catch (err: any) {
            errors.push({
              source: { id: row.id, type: row.type, name: row.name },
              message: publicError(req.user!, err, "unreachable"),
            });
            return null;
          }
        })
      );
      const scopes = results.filter((s): s is ScopeStatus => s !== null);
      return { scopes, errors, configured: rows.length };
    })
  );

  // Latest-frame preview proxy — keeps the imaging PC's address server-side and
  // works even when the browser can't reach it directly. `index` is the
  // image-history index carried in the scope status.
  app.get<{ Querystring: { source?: string; index?: string } }>(
    "/api/widgets/scope/image",
    { preHandler: requireWidget("scope") },
    async (req, reply) => {
      const id = Number(req.query.source);
      const index = req.query.index ?? "";
      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        typeof index !== "string" ||
        !/^\d{1,12}$/.test(index)
      )
        return reply.code(400).send({ error: "bad image request" });
      const row = listIntegrationsForUser(req.user!).find((r) => r.id === id);
      const adapter = row && getAdapter(row.type);
      if (!row || !adapter?.fetchArt) return reply.code(404).send({ error: "no image source" });
      try {
        const upstream = await adapter.fetchArt(rowToConfig(row), index);
        if (!upstream.ok) return reply.code(502).send({ error: `image HTTP ${upstream.status}` });
        return await sendSafeImage(reply, upstream, 60);
      } catch (err: any) {
        return reply.code(502).send({ error: publicError(req.user!, err, "image fetch failed") });
      }
    }
  );

  // ── status: integrations + pinged tabs ────────────────────────────
  // The probe results are shared (cached), then filtered to what each user may
  // see: infra integrations only for admins/integration-managers, and tabs by
  // their berth allow-list — so a crew member never sees "7/7" of admin stuff.
  app.get("/api/widgets/status", { preHandler: requireWidget("status", "stats") }, async (req) => {
    const full = await cached(`status:${moduleAccessScope(req.user!)}`, 30_000, async () => {
      const integrations = listIntegrationsForUser(req.user!, "status");
      const tabs = db
        .prepare(
          "SELECT id, name, url, icon, allowed_groups FROM tabs WHERE ping = 1 ORDER BY sort, name"
        )
        .all() as Array<{
        id: number;
        name: string;
        url: string;
        icon: string;
        allowed_groups: string;
      }>;

      const [integrationResults, tabResults] = await Promise.all([
        Promise.all(
          integrations.map(async (row) => {
            const t0 = Date.now();
            try {
              const result = await getAdapter(row.type)!.test(rowToConfig(row));
              return { kind: "integration", id: row.id, name: row.name, type: row.type, ...result };
            } catch (err: any) {
              return {
                kind: "integration",
                id: row.id,
                name: row.name,
                type: row.type,
                ok: false,
                latencyMs: Date.now() - t0,
                message: publicError(req.user!, err, "unreachable"),
              };
            }
          })
        ),
        Promise.all(
          tabs.map(async (tab) => {
            const t0 = Date.now();
            const base = {
              kind: "tab" as const,
              id: tab.id,
              name: tab.name,
              icon: tab.icon,
              allowed_groups: tab.allowed_groups,
            };
            try {
              // any HTTP answer (even 401/redirect) means the service is up
              await fetchRaw(tab.url, { method: "GET", redirect: "manual" }, 6000, {
                discardBody: true,
              });
              return { ...base, ok: true, latencyMs: Date.now() - t0 };
            } catch {
              return { ...base, ok: false, latencyMs: Date.now() - t0 };
            }
          })
        ),
      ]);

      return { services: [...integrationResults, ...tabResults] };
    });

    const user = req.user!;
    const canSeeInfra = !!(user.permissions.admin || user.permissions.manageIntegrations);
    const services = (full.services as any[])
      .filter((s) =>
        s.kind === "integration" ? canSeeInfra : canSee({ allowed_groups: s.allowed_groups }, user)
      )
      .map((s) => {
        // strip the internal visibility field from the wire payload
        const copy = { ...s };
        delete copy.allowed_groups;
        return copy;
      });
    return { services };
  });
}

/** playing streams sort above paused/buffering */
function stateRank2(state: NowPlayingSession["state"]): number {
  return state === "playing" ? 0 : state === "buffering" ? 1 : 2;
}

// When several sources watch the same backend (Tautulli reads Plex), the same
// stream shows up twice. Collapse by who+what and keep the richer source, so the
// Now Playing widget never double-lists a stream.
const NOW_PLAYING_RANK: Record<string, number> = { tautulli: 0, plex: 2 };
export function dedupeNowPlaying(list: NowPlayingSession[]): NowPlayingSession[] {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const out: NowPlayingSession[] = [];
  const byKey = new Map<string, number>();
  for (const s of list) {
    const key = `${norm(s.user)}|${norm(s.grandparentTitle)}|${norm(s.title)}`;
    const rank = NOW_PLAYING_RANK[s.source.type] ?? 1;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(s);
    } else if (rank < (NOW_PLAYING_RANK[out[at].source.type] ?? 1)) {
      out[at] = s; // a richer source wins the slot
    }
  }
  return out;
}

// Plex and Tautulli read the same library, and several *arrs can point at one
// server — so the same freshly-added title arrives from multiple sources, and a
// batch of new episodes arrives as many rows of one show. Collapse both: key
// movies by title+year, everything else (show/season/episode) by show title,
// and keep the newest add (richer source breaks ties) as the poster.
const RECENT_RANK: Record<string, number> = { tautulli: 0, plex: 2 };
export function dedupeRecent(list: RecentItem[]): RecentItem[] {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const out: RecentItem[] = [];
  const byKey = new Map<string, number>();
  for (const it of list) {
    const key =
      it.kind === "movie"
        ? `movie|${norm(it.title)}|${norm(it.subtitle)}`
        : it.kind === "album"
          ? `album|${norm(it.title)}|${norm(it.subtitle)}`
          : `show|${norm(it.title)}`; // show/season/episode collapse to the series
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(it);
      continue;
    }
    const cur = out[at];
    const newer = (it.addedAt ?? 0) > (cur.addedAt ?? 0);
    const richer =
      (it.addedAt ?? 0) === (cur.addedAt ?? 0) &&
      (RECENT_RANK[it.source.type] ?? 1) < (RECENT_RANK[cur.source.type] ?? 1);
    if (newer || richer) out[at] = it;
  }
  return out;
}

// Multiple *arrs mounting the same volume report the same path — collapse those
// (a real byte-reporting mount wins over a percentage-only one).
export function dedupeMounts(list: StorageMount[]): StorageMount[] {
  const out: StorageMount[] = [];
  const byKey = new Map<string, number>();
  for (const m of list) {
    const key = m.path ? `p|${m.path}|${m.totalBytes ?? 0}` : `h|${m.source.id}|${m.label}`;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(m);
    } else if (m.totalBytes && !out[at].totalBytes) {
      out[at] = m;
    }
  }
  return out;
}

/** down hosts float to the top (they want attention), paused sink */
function hostRank(status: HostMetric["status"]): number {
  switch (status) {
    case "down":
      return 0;
    case "pending":
      return 1;
    case "up":
      return 2;
    case "paused":
      return 3;
  }
}

function stateRank(state: DownloadItem["state"]): number {
  switch (state) {
    case "downloading":
      return 0;
    case "importing":
      return 1;
    case "queued":
      return 2;
    case "paused":
      return 3;
    case "error":
      return 4;
    case "completed":
      return 5;
  }
}
