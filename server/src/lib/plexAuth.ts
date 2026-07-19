import { randomUUID } from "node:crypto";
import { getSetting, setSetting } from "../db.js";
import { fetchRaw } from "../modules/types.js";

/**
 * Plex account linking via the standard PIN OAuth flow. Harbor creates a PIN,
 * sends the user to app.plex.tv to authorise, then polls the PIN until Plex
 * hands back the user's own auth token. We keep a stable per-instance client id
 * so the tokens we mint stay valid across restarts.
 */

const PLEX_PRODUCT = "Harbor";

export function plexClientId(): string {
  let id = getSetting("plex_client_id", "");
  if (!id) {
    id = randomUUID();
    setSetting("plex_client_id", id);
  }
  return id;
}

function plexHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Client-Identifier": plexClientId(),
    ...extra,
  };
}

export interface PlexPin {
  id: number;
  code: string;
}

export async function createPlexPin(): Promise<PlexPin> {
  const res = await fetchRaw(
    "https://plex.tv/api/v2/pins?strong=true",
    { method: "POST", headers: plexHeaders() },
    10_000
  );
  if (!res.ok) throw new Error(`Plex PIN request failed (HTTP ${res.status})`);
  const data: any = await res.json();
  return { id: Number(data.id), code: String(data.code) };
}

/** The app.plex.tv page the user authorises on (uses a hash-fragment payload). */
export function plexAuthUrl(code: string): string {
  const cid = encodeURIComponent(plexClientId());
  const product = encodeURIComponent(PLEX_PRODUCT);
  return (
    `https://app.plex.tv/auth#?clientID=${cid}&code=${encodeURIComponent(code)}` +
    `&context%5Bdevice%5D%5Bproduct%5D=${product}`
  );
}

/** Returns the user's auth token once they've approved, else null (still pending). */
export async function checkPlexPin(id: number): Promise<string | null> {
  const res = await fetchRaw(
    `https://plex.tv/api/v2/pins/${id}`,
    { headers: plexHeaders() },
    10_000
  );
  if (!res.ok) throw new Error(`Plex PIN check failed (HTTP ${res.status})`);
  const data: any = await res.json();
  return data.authToken ? String(data.authToken) : null;
}

export interface PlexUser {
  id: string;
  username: string;
  email?: string;
}

export async function plexUser(token: string): Promise<PlexUser> {
  const res = await fetchRaw(
    "https://plex.tv/api/v2/user",
    { headers: plexHeaders({ "X-Plex-Token": token }) },
    10_000
  );
  if (!res.ok) throw new Error(`Plex user lookup failed (HTTP ${res.status})`);
  const data: any = await res.json();
  return {
    id: String(data.id ?? data.uuid ?? ""),
    username: data.username ?? data.title ?? "Plex user",
    email: data.email ?? undefined,
  };
}
