/**
 * Harbor module system — server side.
 *
 * An integration adapter wraps one external service type (Sonarr, SABnzbd, ...)
 * and implements only the capabilities that service supports. Widget endpoints
 * fan out across every enabled integration and merge the normalized results,
 * tagging each item with its source so the UI can render one unified list.
 *
 * To add a module: create an adapter file in ./adapters and register it in
 * ./registry.ts. The settings UI builds its form from `fields`.
 */

export type Capability =
  | "queue"
  | "calendar"
  | "status"
  | "nowPlaying"
  | "system"
  | "indexers"
  | "containers"
  | "progress"
  | "recentlyAdded"
  | "storage"
  | "sky"
  | "scope";

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required?: boolean;
}

/** Runtime config for one configured integration instance. */
export interface IntegrationConfig {
  id: number;
  type: string;
  name: string;
  url: string;
  /** decrypted secret fields, keyed by FieldSpec.key */
  secrets: Record<string, string>;
}

export interface SourceTag {
  id: number;
  type: string;
  name: string;
}

export type DownloadState =
  "downloading" | "queued" | "paused" | "importing" | "completed" | "error";

/** Actions a download client can perform on a queue item. */
export type QueueAction = "pause" | "resume" | "remove" | "priorityUp" | "priorityDown";

export interface DownloadItem {
  id: string;
  source: SourceTag;
  title: string;
  state: DownloadState;
  /** 0..1 */
  progress: number;
  sizeBytes: number;
  sizeLeftBytes: number;
  /** bytes/sec, when the client reports it */
  speedBps?: number;
  /** seconds remaining, when known */
  etaSeconds?: number;
  category?: string;
  errorMessage?: string;
  /** SxxEyy for episodes (Sonarr) — a compact season/episode badge */
  episode?: string;
  /** a secondary line, e.g. the episode / track / book title */
  subtitle?: string;
  /** media ids (from the *arrs) used to attribute a finished grab to a request */
  externalIds?: { imdb?: string; tvdb?: number; tmdb?: number };
  /** actions available for this item (filled in by the widget endpoint) */
  actions?: QueueAction[];
}

/** One indexer's health, from an indexer manager (Prowlarr). */
export interface IndexerStatus {
  id: string;
  source: SourceTag;
  name: string;
  /** whether it's enabled in the manager (disabled ≠ down) */
  enabled: boolean;
  /** enabled and answering (no recent failures) */
  up: boolean;
  message?: string;
}

export type ContainerState = "running" | "paused" | "restarting" | "exited" | "created" | "dead";
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

/** One container's state, from a Docker manager (Portainer). Read-only. */
export interface ContainerInfo {
  id: string;
  source: SourceTag;
  name: string;
  /** portainer environment/endpoint name, when more than one */
  env?: string;
  state: ContainerState;
  up: boolean;
  health: ContainerHealth;
  /** human uptime/state line, e.g. "Up 2 days" */
  status: string;
  image?: string;
}

/** A "continue" item — reading/listening progress (Audiobookshelf, Kavita). */
export interface ProgressItem {
  id: string;
  source: SourceTag;
  kind: "audiobook" | "book";
  title: string;
  /** author / series line */
  subtitle?: string;
  /** 0..1 */
  progress: number;
  /** ms since epoch of last activity, for recent-first sorting */
  updatedAt?: number;
}

/** One freshly-added library item (Plex/Tautulli) for the poster wall. */
export interface RecentItem {
  id: string;
  source: SourceTag;
  kind: "movie" | "show" | "episode" | "album" | "unknown";
  /** the show / movie / artist title (the poster's headline) */
  title: string;
  /** episode / year / album line under the title */
  subtitle?: string;
  /** raw art path on the source; the browser loads it via the art proxy */
  artPath?: string;
  /** Plex library metadata key, also exposed by Tautulli, for exact deep links */
  ratingKey?: string;
  /** ms since epoch it was added, for recent-first sorting */
  addedAt?: number;
}

/** One filesystem mount's fullness, from the *arrs (real bytes) or Beszel (% only). */
export interface StorageMount {
  id: string;
  source: SourceTag;
  /** mount label or path */
  label: string;
  path?: string;
  /** 0..100 used — always present */
  usedPct: number;
  /** absolute bytes, when the source reports them (the *arrs do; Beszel doesn't) */
  freeBytes?: number;
  totalBytes?: number;
}

/** One media request pulled from a request manager (Jellyseerr/Overseerr). */
export interface RequestItem {
  /** email of the user who made the request (for account tying) */
  requestedByEmail: string;
  mediaType: "movie" | "tv";
  tmdbId?: number;
  tvdbId?: number;
  title?: string;
}

export type ReleaseState = "downloaded" | "downloading" | "missing" | "unaired";

export interface CalendarEvent {
  id: string;
  source: SourceTag;
  /** series or movie title */
  title: string;
  /** episode title / release kind */
  subtitle?: string;
  /** SxxEyy for series */
  episode?: string;
  /** ISO timestamp of the release */
  airDateUtc: string;
  /** date-only releases (movie release dates) have no meaningful time */
  allDay?: boolean;
  state: ReleaseState;
  kind: "movie" | "episode";
  isAnime?: boolean;
  /** ids for click-through links; slug deep-links into the source app */
  externalIds?: { imdb?: string; tvdb?: number; tmdb?: number; slug?: string };
}

export interface CalendarOpts {
  /** include unmonitored entries (Sonarr/Radarr calendar param) */
  unmonitored?: boolean;
}

/**
 * One sky-quality snapshot from a Sky Quality Meter (Unihedron SQM-LE via the
 * `sqm` collector). `mpsas` is magnitudes per square arcsecond — higher = darker
 * (≈22 pristine, ≈18 suburban, 0 = daytime / cap-on). The window fields
 * summarise recent history so the widget can draw a trend and call out how dark
 * it actually got, ignoring daytime zeros.
 */
export interface SkyReading {
  source: SourceTag;
  /** sky brightness, magnitudes per square arcsecond (higher = darker) */
  mpsas: number;
  /** sensor temperature °C, when reported */
  temperatureC?: number;
  /** sensor frequency (Hz) — high = bright sky */
  frequencyHz?: number;
  /** epoch ms of the reading */
  at: number;
  /** length of the summarised history window, in hours */
  windowHours?: number;
  /** darkest (max) mpsas over the window, daytime zeros excluded */
  darkestMpsas?: number;
  /** downsampled mpsas history, oldest → newest, for a sparkline */
  history?: Array<{ at: number; mpsas: number }>;
}

/**
 * A snapshot of an astrophotography imaging rig, normalized from NINA's Advanced
 * API equipment endpoints. Every device is optional and only present when it is
 * actually connected, so the widget renders only the gear that's in play. All
 * temperatures are °C; guider RMS is in arcseconds.
 */
export interface ScopeStatus {
  source: SourceTag;
  /** NINA is reachable (its API answered /version) */
  reachable: boolean;
  /** at least one device is connected */
  anyConnected: boolean;
  camera?: {
    name?: string;
    /** CameraState: Idle / Exposing / Downloading / … */
    state?: string;
    exposing?: boolean;
    /** ISO time the current exposure is expected to finish */
    exposureEndTime?: string;
    temperatureC?: number;
    targetTempC?: number;
    atTargetTemp?: boolean;
    coolerOn?: boolean;
    /** 0..100 */
    coolerPowerPct?: number;
    dewHeaterOn?: boolean;
    gain?: number;
    offset?: number;
  };
  mount?: {
    name?: string;
    tracking?: boolean;
    slewing?: boolean;
    atPark?: boolean;
    atHome?: boolean;
    raString?: string;
    decString?: string;
    altitude?: number;
    azimuth?: number;
    sideOfPier?: string;
    /** hours until the meridian flip, when tracking */
    meridianFlipHours?: number;
  };
  guider?: {
    name?: string;
    /** Guiding / Looping / Calibrating / Stopped / LostLock */
    state?: string;
    rmsTotalArcsec?: number;
    rmsRaArcsec?: number;
    rmsDecArcsec?: number;
    /** recent per-step RA/Dec error in arcseconds, oldest → newest (guide graph) */
    history?: Array<{ ra: number; dec: number }>;
  };
  focuser?: {
    name?: string;
    position?: number;
    temperatureC?: number;
    moving?: boolean;
  };
  filterWheel?: {
    name?: string;
    filter?: string;
    moving?: boolean;
  };
  weather?: {
    name?: string;
    temperatureC?: number;
    humidityPct?: number;
    cloudCoverPct?: number;
    /** ASCOM ObservingConditions reports wind in m/s */
    windSpeedMs?: number;
    dewPointC?: number;
  };
  /** most recent captured frame's stats, from image-history */
  lastImage?: {
    /** image-history index of this frame — used to fetch its preview */
    index?: number;
    hfr?: number;
    stars?: number;
    filter?: string;
    exposureSeconds?: number;
    temperatureC?: number;
    rms?: string;
    date?: string;
    mean?: number;
    imageType?: string;
  };
  /** current-night actions, newest first */
  events?: ScopeEvent[];
  /** Adapter-only capture samples; removed before the API response is sent. */
  activitySamples?: ScopeActivitySample[];
}

export type ScopeEventKind =
  "exposure" | "target" | "meridian" | "mount" | "guide" | "focus" | "filter";

export interface ScopeEvent {
  id: string;
  kind: ScopeEventKind;
  title: string;
  detail?: string;
  /** epoch milliseconds */
  at: number;
}

export interface ScopeActivitySample extends Omit<ScopeEvent, "id"> {
  /** stable source-side identity used to de-duplicate image-history polling */
  key: string;
}

export type PlaybackState = "playing" | "paused" | "buffering";
export type StreamDecision = "direct play" | "direct stream" | "transcode";

/** One active playback session (a stream on Plex/Jellyfin/ABS/…). */
export interface NowPlayingSession {
  id: string;
  source: SourceTag;
  /** track / episode / movie title */
  title: string;
  /** series or artist/album — the "show" line above the title */
  grandparentTitle?: string;
  /** SxxEyy, album, or other secondary line */
  subtitle?: string;
  kind: "movie" | "episode" | "track" | "photo" | "clip" | "unknown";
  /** who is watching/listening */
  user?: string;
  /** player / device name */
  player?: string;
  state: PlaybackState;
  /** 0..1 through the item */
  progress: number;
  durationMs?: number;
  viewOffsetMs?: number;
  decision?: StreamDecision;
  /** total stream bandwidth in kbps, when reported */
  bandwidthKbps?: number;
  /** raw art path on the source; the browser loads it via the art proxy */
  artPath?: string;
}

export type HostState = "up" | "down" | "paused" | "pending";

/** Current metrics snapshot for one monitored host (Beszel/Glances/…). */
export interface HostMetric {
  id: string;
  source: SourceTag;
  name: string;
  status: HostState;
  /** all percentages are 0..100 */
  cpuPct?: number;
  memPct?: number;
  diskPct?: number;
  gpuPct?: number;
  /** total network throughput in bytes/sec */
  netBps?: number;
  uptimeSec?: number;
  cores?: number;
  cpuModel?: string;
  hostname?: string;
  /** dashboard temperature in °C, when reported */
  tempC?: number;
  agentVersion?: string;
}

export interface StatusResult {
  ok: boolean;
  latencyMs: number;
  version?: string;
  message?: string;
}

export interface AdapterMeta {
  type: string;
  label: string;
  /** default port hint shown in the settings UI */
  urlPlaceholder: string;
  capabilities: Capability[];
  fields: FieldSpec[];
  /** grouping for the "add integration" catalog; defaults to "Other" */
  category?: string;
}

export interface IntegrationAdapter extends AdapterMeta {
  test(cfg: IntegrationConfig): Promise<StatusResult>;
  fetchQueue?(cfg: IntegrationConfig): Promise<DownloadItem[]>;
  /** which queue actions this client supports (empty/absent = read-only) */
  queueActions?: QueueAction[];
  /** perform an action on one queue item; nativeId is the id after the source prefix */
  runQueueAction?(cfg: IntegrationConfig, nativeId: string, action: QueueAction): Promise<void>;
  fetchCalendar?(
    cfg: IntegrationConfig,
    startIso: string,
    endIso: string,
    opts?: CalendarOpts
  ): Promise<CalendarEvent[]>;
  fetchNowPlaying?(cfg: IntegrationConfig): Promise<NowPlayingSession[]>;
  /** stream art (poster/thumb) for a session, proxied so tokens stay server-side */
  fetchArt?(cfg: IntegrationConfig, artPath: string): Promise<Response>;
  fetchSystems?(cfg: IntegrationConfig): Promise<HostMetric[]>;
  /** pull the current media requests (request managers only) */
  fetchRequests?(cfg: IntegrationConfig): Promise<RequestItem[]>;
  /** list indexers + health (Prowlarr) */
  fetchIndexers?(cfg: IntegrationConfig): Promise<IndexerStatus[]>;
  /** list containers + state/health (Portainer) — read-only */
  fetchContainers?(cfg: IntegrationConfig): Promise<ContainerInfo[]>;
  /** reading/listening progress (Audiobookshelf, Kavita) */
  fetchProgress?(cfg: IntegrationConfig): Promise<ProgressItem[]>;
  /** recently-added library items for the poster wall (Plex, Tautulli) */
  fetchRecentlyAdded?(cfg: IntegrationConfig): Promise<RecentItem[]>;
  /** disk mounts + fullness (the *arrs, Beszel) */
  fetchStorage?(cfg: IntegrationConfig): Promise<StorageMount[]>;
  /** latest sky-quality reading + recent history (SQM sky meters) */
  fetchSky?(cfg: IntegrationConfig, windowHours: number): Promise<SkyReading | null>;
  /** raw sky readings within an inclusive epoch-seconds window (for the heatmap) */
  fetchSkyReadings?(
    cfg: IntegrationConfig,
    sinceSec: number,
    untilSec: number,
    limit: number
  ): Promise<Array<{ ts: number; mpsas: number }>>;
  /** imaging-rig status (NINA Advanced API) */
  fetchScope?(cfg: IntegrationConfig): Promise<ScopeStatus | null>;
}

/** fetch with a hard timeout — integrations must never hang a widget. */
export async function fetchJson<T = any>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<T> {
  const res = await fetchRaw(url, init, timeoutMs, { maxBytes: 2 * 1024 * 1024 });
  const host = new URL(url).host;

  // A login/SSO proxy in front of the service answers API calls with a 401/403
  // or an HTML login page — Harbor's server has no browser session to satisfy
  // it. Surface an actionable message rather than a vague parse error.
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${host} returned ${res.status}. This URL looks like it's behind an auth proxy (Google OAuth / SSO). ` +
        `Set the Internal URL to a direct address that bypasses SSO — a Docker service name (http://sonarr:8989) or LAN IP — not the public URL.`
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);

  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    const looksLikeLogin = /<html|<!doctype|sign in|oauth|accounts\.google|forbidden/i.test(
      body.slice(0, 600)
    );
    throw new Error(
      looksLikeLogin
        ? `${host} returned a web page instead of API data — the Internal URL is behind SSO. Use a direct (non-OAuth) address.`
        : `${host} returned an unreadable (non-JSON) response.`
    );
  }
}

export async function fetchRaw(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
  options: import("../lib/outbound.js").OutboundOptions = {}
): Promise<Response> {
  const { safeFetch } = await import("../lib/outbound.js");
  return safeFetch(url, init, timeoutMs, options);
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}
