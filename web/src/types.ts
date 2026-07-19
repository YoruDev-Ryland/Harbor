export type Permission =
  | "admin"
  | "viewOverview"
  | "editLayout"
  | "manageBerths"
  | "manageIntegrations"
  | "manageSecrets"
  | "controlDownloads"
  | "manageSettings"
  | "manageMonitors"
  | "manageNotifications"
  | "manageUsers"
  | "manageCredentials";

export type PermissionSet = Record<Permission, boolean>;

export interface PermissionMeta {
  key: Permission;
  label: string;
  desc: string;
}

export interface Group {
  id: number;
  name: string;
  /** stored flags exactly as configured */
  permissions: PermissionSet;
  /** effective flags (admin implies all) */
  effective: PermissionSet;
  is_default: boolean;
  memberCount: number;
}

export interface User {
  id: number;
  username: string;
  email: string | null;
  /** derived from the group's admin permission */
  role: "admin" | "user";
  theme: string;
  has_password: boolean;
  disabled: boolean;
  groupId: number | null;
  groupName: string | null;
  /** effective permissions (admin implies all) */
  permissions: PermissionSet;
}

export interface MeResponse {
  user: User | null;
  sso: boolean;
  needsSetup: boolean;
  title: string;
  defaultTheme: string;
  /** effective dashboard layout for this user (personal if set, else the shared default) */
  layout: string;
  /** the shared default layout (source of module group-visibility rules) */
  defaultLayout: string;
  /** whether the user has saved a personal layout that overrides the default */
  hasCustomLayout: boolean;
  /** JSON string array of group names in display order ("" = natural order) */
  groupOrder: string;
  /** JSON string of the shared calendar click-action map ("" = defaults) */
  calendarActions: string;
  authProxy: boolean;
  version: string;
  schemaVersion: number;
}

export interface Tab {
  id: number;
  name: string;
  url: string;
  local_url: string;
  icon: string;
  grp: string;
  sort: number;
  open_mode: "embed" | "new-tab";
  ping: number;
  integration_id?: number | null;
  /** group ids allowed to see this berth; [] = everyone */
  allowed_groups: number[];
}

export interface SourceTag {
  id: number;
  type: string;
  name: string;
}

export type DownloadState =
  "downloading" | "queued" | "paused" | "importing" | "completed" | "error";

export type QueueAction = "pause" | "resume" | "remove" | "priorityUp" | "priorityDown";

export interface DownloadItem {
  id: string;
  source: SourceTag;
  title: string;
  /** SxxEyy badge for episodes */
  episode?: string;
  /** secondary line (episode / track / book title) */
  subtitle?: string;
  state: DownloadState;
  progress: number;
  sizeBytes: number;
  sizeLeftBytes: number;
  speedBps?: number;
  etaSeconds?: number;
  category?: string;
  errorMessage?: string;
  actions?: QueueAction[];
}

export interface SourceError {
  source: SourceTag;
  message: string;
}

export interface DownloadsResponse {
  items: DownloadItem[];
  errors: SourceError[];
  totalSpeedBps: number;
  sources: SourceTag[];
}

export type ReleaseState = "downloaded" | "downloading" | "missing" | "unaired";

export interface CalendarEvent {
  id: string;
  source: SourceTag;
  title: string;
  subtitle?: string;
  episode?: string;
  airDateUtc: string;
  allDay?: boolean;
  state: ReleaseState;
  kind: "movie" | "episode";
  isAnime?: boolean;
  externalIds?: { imdb?: string; tvdb?: number; tmdb?: number; slug?: string };
}

export interface CalendarResponse {
  events: CalendarEvent[];
  errors: SourceError[];
  start: string;
  end: string;
}

export type PlaybackState = "playing" | "paused" | "buffering";
export type StreamDecision = "direct play" | "direct stream" | "transcode";

export interface NowPlayingSession {
  id: string;
  source: SourceTag;
  title: string;
  grandparentTitle?: string;
  subtitle?: string;
  kind: "movie" | "episode" | "track" | "photo" | "clip" | "unknown";
  user?: string;
  player?: string;
  state: PlaybackState;
  progress: number;
  durationMs?: number;
  viewOffsetMs?: number;
  decision?: StreamDecision;
  bandwidthKbps?: number;
  artPath?: string;
}

export interface NowPlayingResponse {
  sessions: NowPlayingSession[];
  errors: SourceError[];
}

export type HostState = "up" | "down" | "paused" | "pending";

export interface HostMetric {
  id: string;
  source: SourceTag;
  name: string;
  status: HostState;
  cpuPct?: number;
  memPct?: number;
  diskPct?: number;
  gpuPct?: number;
  netBps?: number;
  uptimeSec?: number;
  cores?: number;
  cpuModel?: string;
  hostname?: string;
  tempC?: number;
  agentVersion?: string;
}

export interface SystemResponse {
  hosts: HostMetric[];
  errors: SourceError[];
}

export interface ServiceStatus {
  kind: "integration" | "tab";
  id: number;
  name: string;
  type?: string;
  icon?: string;
  ok: boolean;
  latencyMs: number;
  version?: string;
  message?: string;
}

export interface StatusResponse {
  services: ServiceStatus[];
}

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required?: boolean;
}

export interface AdapterMeta {
  type: string;
  label: string;
  urlPlaceholder: string;
  capabilities: Array<"queue" | "calendar" | "status" | "nowPlaying" | "system">;
  fields: FieldSpec[];
  category?: string;
}

export interface Integration {
  id: number;
  type: string;
  label: string;
  name: string;
  url: string;
  public_url: string;
  enabled: boolean;
  use_downloads: boolean;
  use_calendar: boolean;
  use_status: boolean;
  capabilities: string[];
  hasSecrets: boolean;
  credentialsComplete: boolean;
  berth: {
    enabled: boolean;
    icon: string;
    grp: string;
    sort: number;
    open_mode: "embed" | "new-tab";
    allowed_groups: number[];
  };
}

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  notify_email: number;
  created_at: string;
  last_login: string | null;
  has_password: number;
  disabled: number;
  is_admin: number;
  identities: Array<{ id: number; provider: string; subject: string }>;
  group_id: number | null;
  group_name: string | null;
}

export type NotifyKind = "info" | "success" | "warn" | "error";

export interface AppNotification {
  id: number;
  kind: NotifyKind;
  title: string;
  body: string;
  created_at: string;
}

export interface NotificationsResponse {
  items: AppNotification[];
  unread: number;
}

export interface ContactInfo {
  email: string | null;
  phone: string | null;
  notify_email: number;
  notify_prefs: string | null;
  /** 'all' | 'requested' — which finished downloads email this user */
  download_scope: string;
  /** explicit request-manager email when it differs from the account email */
  request_email: string | null;
}

/** Notification categories a user can individually opt in/out of. */
export type NotifyCategory = "downloads" | "services" | "disk" | "websites";

// ── indexers (Prowlarr) ──────────────────────────────────────────────
export interface IndexerStatus {
  id: string;
  source: SourceTag;
  name: string;
  enabled: boolean;
  up: boolean;
  message?: string;
}
export interface IndexersResponse {
  indexers: IndexerStatus[];
  errors: SourceError[];
}

// ── containers (Portainer) ───────────────────────────────────────────
export type ContainerState = "running" | "paused" | "restarting" | "exited" | "created" | "dead";
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";
export interface ContainerInfo {
  id: string;
  source: SourceTag;
  name: string;
  env?: string;
  state: ContainerState;
  up: boolean;
  health: ContainerHealth;
  status: string;
  image?: string;
}
export interface ContainersResponse {
  containers: ContainerInfo[];
  errors: SourceError[];
}

// ── continue: reading/listening progress (Audiobookshelf, Kavita) ────
export interface ProgressItem {
  id: string;
  source: SourceTag;
  kind: "audiobook" | "book";
  title: string;
  subtitle?: string;
  progress: number;
  updatedAt?: number;
}
export interface ProgressResponse {
  items: ProgressItem[];
  errors: SourceError[];
  configured: number;
}

// ── recently added (Plex/Tautulli poster wall) ──────────────────────
export interface RecentItem {
  id: string;
  source: SourceTag;
  kind: "movie" | "show" | "episode" | "album" | "unknown";
  title: string;
  subtitle?: string;
  artPath?: string;
  addedAt?: number;
}
export interface RecentResponse {
  items: RecentItem[];
  errors: SourceError[];
}

// ── storage (free-space bars, the *arrs + Beszel) ───────────────────
export interface StorageMount {
  id: string;
  source: SourceTag;
  label: string;
  path?: string;
  usedPct: number;
  freeBytes?: number;
  totalBytes?: number;
}
export interface StorageResponse {
  mounts: StorageMount[];
  errors: SourceError[];
}

export interface SkyReading {
  source: SourceTag;
  mpsas: number;
  temperatureC?: number;
  frequencyHz?: number;
  at: number;
  windowHours?: number;
  darkestMpsas?: number;
  history?: Array<{ at: number; mpsas: number }>;
}
export interface SkyResponse {
  readings: SkyReading[];
  errors: SourceError[];
  configured: number;
}

export interface SkyHeatmapBucket {
  /** bucket start, unix epoch seconds (30-min buckets) */
  t: number;
  /** average MSAS in the bucket */
  v: number;
  /** sample count */
  n: number;
}
export interface SkyHeatmapResponse {
  year: number;
  buckets: SkyHeatmapBucket[];
  errors: SourceError[];
  configured: number;
  /** earliest / latest year with data, for the year selector */
  minYear: number;
  maxYear: number;
  updatedAt: number;
}

export interface ScopeStatus {
  source: SourceTag;
  reachable: boolean;
  anyConnected: boolean;
  camera?: {
    name?: string;
    state?: string;
    exposing?: boolean;
    exposureEndTime?: string;
    temperatureC?: number;
    targetTempC?: number;
    atTargetTemp?: boolean;
    coolerOn?: boolean;
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
    meridianFlipHours?: number;
  };
  guider?: {
    name?: string;
    state?: string;
    rmsTotalArcsec?: number;
    rmsRaArcsec?: number;
    rmsDecArcsec?: number;
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
    windSpeedMs?: number;
    dewPointC?: number;
  };
  lastImage?: {
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
}
export interface ScopeResponse {
  scopes: ScopeStatus[];
  errors: SourceError[];
  configured: number;
}

export type SiteState = "up" | "changed" | "error" | "down";

export interface Monitor {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  expect_status: number | null;
  keyword: string | null;
  sort: number;
  state: SiteState | null;
  status: number | null;
  latency: number | null;
  message: string | null;
  checked_at: string | null;
  /** rolling 24h uptime %, or null if no history yet */
  uptime: number | null;
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  allowInsecureTls: boolean;
  user: string;
  from: string;
  hasPass: boolean;
  customCa: boolean;
}

export interface PushConfig {
  enabled: boolean;
  url: string;
  topic: string;
  hasToken: boolean;
}
