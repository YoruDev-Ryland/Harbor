import type { AdapterMeta, IntegrationAdapter } from "./types.js";
import { lidarr, radarr, readarr, sonarr } from "./adapters/arr.js";
import { sabnzbd } from "./adapters/sabnzbd.js";
import { nzbget } from "./adapters/nzbget.js";
import { qbittorrent } from "./adapters/qbittorrent.js";
import { transmission } from "./adapters/transmission.js";
import { prowlarr } from "./adapters/prowlarr.js";
import { plex } from "./adapters/plex.js";
import { beszel } from "./adapters/beszel.js";
import { jellyseerr } from "./adapters/jellyseerr.js";
import { tautulli } from "./adapters/tautulli.js";
import { audiobookshelf } from "./adapters/audiobookshelf.js";
import { kavita } from "./adapters/kavita.js";
import { portainer } from "./adapters/portainer.js";
import { sqm } from "./adapters/sqm.js";
import { nina } from "./adapters/nina.js";

/** Register new integration adapters here — that's the whole ceremony. */
const adapters: IntegrationAdapter[] = [
  sonarr,
  radarr,
  lidarr,
  readarr,
  prowlarr,
  sabnzbd,
  nzbget,
  qbittorrent,
  transmission,
  plex,
  tautulli,
  beszel,
  portainer,
  audiobookshelf,
  kavita,
  jellyseerr,
  sqm,
  nina,
];

const byType = new Map(adapters.map((a) => [a.type, a]));

/**
 * Which shelf each adapter sits on in the "add integration" catalog. Kept here
 * (rather than on every adapter) so the whole taxonomy is visible in one place;
 * a type with no entry falls back to "Other".
 */
const CATEGORIES: Record<string, string> = {
  sonarr: "Media library",
  radarr: "Media library",
  lidarr: "Media library",
  readarr: "Media library",
  prowlarr: "Indexers",
  sabnzbd: "Download clients",
  nzbget: "Download clients",
  qbittorrent: "Download clients",
  transmission: "Download clients",
  plex: "Media servers",
  tautulli: "Media servers",
  jellyseerr: "Requests",
  audiobookshelf: "Books & audiobooks",
  kavita: "Books & audiobooks",
  beszel: "Monitoring",
  portainer: "Monitoring",
  sqm: "Astrophotography",
  nina: "Astrophotography",
};

export function getAdapter(type: string): IntegrationAdapter | undefined {
  return byType.get(type);
}

export function adapterCatalog(): AdapterMeta[] {
  return adapters.map(({ type, label, urlPlaceholder, capabilities, fields }) => ({
    type,
    label,
    urlPlaceholder,
    capabilities,
    fields,
    category: CATEGORIES[type] ?? "Other",
  }));
}
