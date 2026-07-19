import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { requireAnyPerm, requirePerm } from "../auth/auth.js";
import { adapterCatalog, getAdapter } from "../modules/registry.js";
import { parseAllowed, serializeAllowed } from "./tabs.js";
import { fetchJson } from "../modules/types.js";
import type { IntegrationConfig } from "../modules/types.js";
import type { User } from "../auth/auth.js";
import { canUseIntegration } from "../lib/moduleAccess.js";
import { normalizeHttpUrl } from "../lib/urlValidation.js";
import { hasOnlyKeys } from "../auth/validation.js";

const requireManage = requirePerm("manageIntegrations");
const requireIntegrationAccess = requireAnyPerm("manageIntegrations", "manageSecrets");

const plexClientId = `harbor-${randomUUID()}`;
const plexPins = new Map<number, { userId: number; expiresAt: number }>();

function prunePlexPins(): void {
  const now = Date.now();
  for (const [id, pin] of plexPins) if (pin.expiresAt <= now) plexPins.delete(id);
  if (plexPins.size > 1_000) plexPins.clear();
}

function plexHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": "Harbor",
    "X-Plex-Client-Identifier": plexClientId,
  };
}

function plexAuthUrl(code: string): string {
  const params = new URLSearchParams({
    clientID: plexClientId,
    code,
    "context[device][product]": "Harbor",
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export interface IntegrationRow {
  id: number;
  type: string;
  name: string;
  url: string;
  public_url: string;
  secret: string;
  enabled: number;
  use_downloads: number;
  use_calendar: number;
  use_status: number;
}

interface IntegrationTabRow {
  id: number;
  icon: string;
  grp: string;
  sort: number;
  open_mode: "embed" | "new-tab";
  allowed_groups: string;
}

export function rowToConfig(row: IntegrationRow): IntegrationConfig {
  let secrets: Record<string, string> = {};
  if (row.secret) {
    try {
      secrets = JSON.parse(decrypt(row.secret));
    } catch {
      // undecryptable (secret rotated) — adapter test will surface the failure
    }
  }
  return { id: row.id, type: row.type, name: row.name, url: row.url, secrets };
}

export function listIntegrations(filter?: "downloads" | "calendar" | "status"): IntegrationRow[] {
  const rows = db
    .prepare("SELECT * FROM integrations WHERE enabled = 1 ORDER BY name")
    .all() as IntegrationRow[];
  if (!filter) return rows;
  const col = `use_${filter}` as const;
  return rows.filter((r) => r[col] === 1);
}

export function listIntegrationsForUser(
  user: User,
  filter?: "downloads" | "calendar" | "status"
): IntegrationRow[] {
  return listIntegrations(filter).filter((row) => canUseIntegration(user, row.id));
}

function defaultBerthIcon(type: string): string {
  switch (type) {
    case "sonarr":
      return "tv";
    case "radarr":
      return "film";
    case "lidarr":
      return "music";
    case "readarr":
      return "book";
    case "prowlarr":
      return "rss";
    case "sabnzbd":
    case "nzbget":
    case "qbittorrent":
    case "transmission":
      return "download";
    case "plex":
      return "play";
    case "beszel":
      return "activity";
    default:
      return "globe";
  }
}

function publicBerthUrl(row: Pick<IntegrationRow, "url" | "public_url">): string {
  return row.public_url || row.url;
}

function localBerthUrl(row: Pick<IntegrationRow, "url" | "public_url">): string {
  return row.public_url ? row.url : "";
}

function linkedBerth(row: IntegrationRow): IntegrationTabRow | undefined {
  return db
    .prepare(
      "SELECT id, icon, grp, sort, open_mode, allowed_groups FROM tabs WHERE integration_id = ?"
    )
    .get(row.id) as IntegrationTabRow | undefined;
}

function syncLinkedBerth(row: IntegrationRow, berth?: IntegrationBody["berth"]): void {
  if (!berth?.enabled) {
    db.prepare("DELETE FROM tabs WHERE integration_id = ?").run(row.id);
    return;
  }

  const existing = linkedBerth(row);
  const icon = berth.icon?.trim() || existing?.icon || defaultBerthIcon(row.type);
  const grp = berth.grp !== undefined ? berth.grp.trim() : (existing?.grp ?? "");
  const sort = berth.sort ?? existing?.sort ?? 0;
  const openMode = berth.open_mode === "new-tab" ? "new-tab" : (existing?.open_mode ?? "embed");
  const allowed =
    berth.allowed_groups !== undefined
      ? serializeAllowed(berth.allowed_groups)
      : (existing?.allowed_groups ?? "");
  const tabUrl = publicBerthUrl(row);
  const localUrl = localBerthUrl(row);

  if (existing) {
    db.prepare(
      `UPDATE tabs SET name = ?, url = ?, local_url = ?, icon = ?, grp = ?, sort = ?,
       open_mode = ?, allowed_groups = ?, ping = 0 WHERE integration_id = ?`
    ).run(row.name, tabUrl, localUrl, icon, grp, sort, openMode, allowed, row.id);
    return;
  }

  db.prepare(
    `INSERT INTO tabs (name, url, local_url, icon, grp, sort, open_mode, allowed_groups, ping, integration_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(row.name, tabUrl, localUrl, icon, grp, sort, openMode, allowed, row.id);
}

function publicView(row: IntegrationRow) {
  const adapter = getAdapter(row.type);
  const berth = linkedBerth(row);
  const storedSecrets = rowToConfig(row).secrets;
  const requiredSecrets =
    adapter?.fields.filter((field) => field.required).map((field) => field.key) ?? [];
  return {
    id: row.id,
    type: row.type,
    label: adapter?.label ?? row.type,
    name: row.name,
    url: row.url,
    public_url: row.public_url,
    enabled: !!row.enabled,
    use_downloads: !!row.use_downloads,
    use_calendar: !!row.use_calendar,
    use_status: !!row.use_status,
    capabilities: adapter?.capabilities ?? [],
    hasSecrets: !!row.secret,
    credentialsComplete: requiredSecrets.every((key) => !!storedSecrets[key]),
    berth: berth
      ? {
          enabled: true,
          icon: berth.icon,
          grp: berth.grp,
          sort: berth.sort,
          open_mode: berth.open_mode,
          allowed_groups: parseAllowed(berth.allowed_groups),
        }
      : {
          enabled: false,
          icon: defaultBerthIcon(row.type),
          grp: "",
          sort: 0,
          open_mode: "embed",
          allowed_groups: [],
        },
  };
}

interface IntegrationBerthBody {
  enabled: boolean;
  icon?: string;
  grp?: string;
  sort?: number;
  open_mode?: "embed" | "new-tab";
  allowed_groups?: number[];
}

interface IntegrationBody {
  type: string;
  name: string;
  url: string;
  public_url?: string;
  secrets?: Record<string, string>;
  enabled?: boolean;
  use_downloads?: boolean;
  use_calendar?: boolean;
  use_status?: boolean;
  berth?: IntegrationBerthBody;
}

function cleanSecrets(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  value: unknown
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(adapter.fields.map((field) => field.key));
  const clean: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value as Record<string, unknown>)) {
    if (
      !allowed.has(key) ||
      typeof secret !== "string" ||
      secret.length > 4_096 ||
      /[\r\n]/.test(secret)
    )
      return null;
    if (secret) clean[key] = secret;
  }
  return JSON.stringify(clean).length <= 64_000 ? clean : null;
}

function validBerth(value: unknown): value is IntegrationBerthBody | undefined {
  if (value === undefined) return true;
  if (!hasOnlyKeys(value, ["enabled", "icon", "grp", "sort", "open_mode", "allowed_groups"]))
    return false;
  const berth = value as Record<string, unknown>;
  return (
    typeof berth.enabled === "boolean" &&
    (berth.icon === undefined || (typeof berth.icon === "string" && berth.icon.length <= 64)) &&
    (berth.grp === undefined || (typeof berth.grp === "string" && berth.grp.length <= 128)) &&
    (berth.sort === undefined ||
      (Number.isInteger(berth.sort) &&
        Number(berth.sort) >= -100_000 &&
        Number(berth.sort) <= 100_000)) &&
    (berth.open_mode === undefined ||
      berth.open_mode === "embed" ||
      berth.open_mode === "new-tab") &&
    (berth.allowed_groups === undefined ||
      (Array.isArray(berth.allowed_groups) &&
        berth.allowed_groups.length <= 200 &&
        berth.allowed_groups.every((id) => Number.isInteger(id) && id > 0)))
  );
}

function validIntegrationFlags(body: Record<string, unknown>): boolean {
  return ["enabled", "use_downloads", "use_calendar", "use_status"].every(
    (key) => body[key] === undefined || typeof body[key] === "boolean"
  );
}

export function integrationRoutes(app: FastifyInstance): void {
  app.post("/api/integrations/plex/pin", { preHandler: requireManage }, async (req) => {
    prunePlexPins();
    const pin = await fetchJson<any>("https://plex.tv/api/v2/pins?strong=true", {
      method: "POST",
      headers: plexHeaders(),
    });
    const id = Number(pin.id);
    const expiresAt = Date.parse(pin.expiresAt) || Date.now() + Number(pin.expiresIn ?? 300) * 1000;
    plexPins.set(id, { userId: req.user!.id, expiresAt });
    return {
      id,
      code: pin.code,
      authUrl: plexAuthUrl(pin.code),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/integrations/plex/pin/:id",
    { preHandler: requireManage },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1)
        return reply.code(400).send({ error: "invalid Plex sign-in id" });
      prunePlexPins();
      const known = plexPins.get(id);
      if (!known || known.userId !== req.user!.id)
        return reply.code(404).send({ error: "Plex sign-in expired or unknown" });
      if (Date.now() > known.expiresAt) {
        plexPins.delete(id);
        return reply.code(410).send({ error: "Plex sign-in expired" });
      }

      const pin = await fetchJson<any>(`https://plex.tv/api/v2/pins/${id}`, {
        headers: plexHeaders(),
      });
      if (!pin.authToken) return { authorized: false };
      plexPins.delete(id);
      return { authorized: true, token: pin.authToken };
    }
  );

  // Catalog of available adapter types (drives the "add integration" form).
  app.get("/api/integrations/catalog", { preHandler: requireIntegrationAccess }, async () =>
    adapterCatalog()
  );

  app.get("/api/integrations", { preHandler: requireIntegrationAccess }, async () => {
    const rows = db.prepare("SELECT * FROM integrations ORDER BY name").all() as IntegrationRow[];
    return rows.map(publicView);
  });

  app.post<{ Body: IntegrationBody }>(
    "/api/integrations",
    { preHandler: requireManage },
    async (req, reply) => {
      const b = req.body ?? ({} as IntegrationBody);
      if (
        !hasOnlyKeys(b, [
          "type",
          "name",
          "url",
          "public_url",
          "secrets",
          "enabled",
          "use_downloads",
          "use_calendar",
          "use_status",
          "berth",
        ]) ||
        !validIntegrationFlags(b as unknown as Record<string, unknown>) ||
        !validBerth(b.berth)
      )
        return reply.code(400).send({ error: "invalid integration settings" });
      const adapter = getAdapter(b.type);
      if (!adapter) return reply.code(400).send({ error: `unknown integration type: ${b.type}` });
      const url = normalizeHttpUrl(b.url);
      const publicUrl = normalizeHttpUrl(b.public_url ?? "", true);
      if (
        typeof b.name !== "string" ||
        !b.name.trim() ||
        b.name.trim().length > 128 ||
        !url ||
        publicUrl === null
      )
        return reply.code(400).send({ error: "valid name and http(s) URLs are required" });
      const secrets = cleanSecrets(adapter, b.secrets);
      if (secrets === null)
        return reply.code(400).send({ error: "invalid integration credentials" });
      if (Object.keys(secrets).length > 0 && !req.user!.permissions.manageSecrets)
        return reply.code(403).send({ error: "service credential permission required" });
      if (adapter.fields.some((field) => field.required && !secrets[field.key]))
        return reply.code(400).send({ error: "required integration credentials are missing" });
      const info = db
        .prepare(
          `INSERT INTO integrations (type, name, url, public_url, secret, enabled, use_downloads, use_calendar, use_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          b.type,
          b.name.trim(),
          url,
          publicUrl,
          Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : "",
          b.enabled === false ? 0 : 1,
          b.use_downloads === false ? 0 : 1,
          b.use_calendar === false ? 0 : 1,
          b.use_status === false ? 0 : 1
        );
      const row = db
        .prepare("SELECT * FROM integrations WHERE id = ?")
        .get(info.lastInsertRowid) as IntegrationRow;
      if (b.berth?.enabled) syncLinkedBerth(row, b.berth);
      req.log.info(
        {
          actorId: req.user!.id,
          integrationId: row.id,
          credentialsEntered: Object.keys(secrets).length > 0,
        },
        "integration created"
      );
      return publicView(row);
    }
  );

  app.patch<{ Params: { id: string }; Body: Partial<IntegrationBody> }>(
    "/api/integrations/:id",
    { preHandler: requireIntegrationAccess },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM integrations WHERE id = ?").get(req.params.id) as
        IntegrationRow | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? {};
      if (
        !hasOnlyKeys(b, [
          "type",
          "name",
          "url",
          "public_url",
          "secrets",
          "enabled",
          "use_downloads",
          "use_calendar",
          "use_status",
          "berth",
        ]) ||
        !validIntegrationFlags(b as Record<string, unknown>) ||
        !validBerth(b.berth)
      )
        return reply.code(400).send({ error: "invalid integration settings" });
      if (
        !req.user!.permissions.manageIntegrations &&
        Object.keys(b).some((key) => key !== "secrets")
      )
        return reply.code(403).send({ error: "integration management permission required" });
      const adapter = getAdapter(row.type)!;
      const currentUrl = normalizeHttpUrl(row.url);
      const url = b.url !== undefined ? normalizeHttpUrl(b.url) : currentUrl;
      const publicUrl =
        b.public_url !== undefined
          ? normalizeHttpUrl(b.public_url, true)
          : normalizeHttpUrl(row.public_url, true);
      if (
        url === null ||
        publicUrl === null ||
        (b.name !== undefined &&
          (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 128)) ||
        (b.type !== undefined && b.type !== row.type)
      )
        return reply.code(400).send({ error: "invalid integration settings" });
      const submittedSecrets = cleanSecrets(adapter, b.secrets);
      if (submittedSecrets === null)
        return reply.code(400).send({ error: "invalid integration credentials" });
      if (Object.keys(submittedSecrets).length > 0 && !req.user!.permissions.manageSecrets)
        return reply.code(403).send({ error: "service credential permission required" });
      // merge new secret fields over existing ones so a partial edit keeps the rest
      let secret = row.secret;
      const current = rowToConfig(row).secrets;
      const originChanged =
        currentUrl === null || new URL(url).origin !== new URL(currentUrl).origin;
      const identityChanged = adapter.fields
        .filter((field) => field.type !== "password")
        .some(
          (field) =>
            submittedSecrets[field.key] !== undefined &&
            submittedSecrets[field.key] !== (current[field.key] ?? "")
        );
      if (originChanged || identityChanged) {
        // A retained credential must never be sent to a newly selected host or
        // silently rebound to another username. Only values entered in this
        // request survive the identity change.
        secret = Object.keys(submittedSecrets).length
          ? encrypt(JSON.stringify(submittedSecrets))
          : "";
      } else if (Object.keys(submittedSecrets).length > 0) {
        secret = encrypt(JSON.stringify({ ...current, ...submittedSecrets }));
      }
      db.prepare(
        `UPDATE integrations SET name = ?, url = ?, public_url = ?, secret = ?, enabled = ?,
         use_downloads = ?, use_calendar = ?, use_status = ? WHERE id = ?`
      ).run(
        b.name?.trim() || row.name,
        url,
        publicUrl,
        secret,
        (b.enabled ?? !!row.enabled) ? 1 : 0,
        (b.use_downloads ?? !!row.use_downloads) ? 1 : 0,
        (b.use_calendar ?? !!row.use_calendar) ? 1 : 0,
        (b.use_status ?? !!row.use_status) ? 1 : 0,
        row.id
      );
      const updated = db
        .prepare("SELECT * FROM integrations WHERE id = ?")
        .get(row.id) as IntegrationRow;
      if (b.berth !== undefined || linkedBerth(updated)) {
        syncLinkedBerth(updated, b.berth ?? { enabled: true });
      }
      req.log.info(
        {
          actorId: req.user!.id,
          integrationId: row.id,
          originChanged,
          identityChanged,
          credentialsEntered: Object.keys(submittedSecrets).length > 0,
          credentialsCleared:
            (originChanged || identityChanged) && Object.keys(submittedSecrets).length === 0,
        },
        "integration configuration changed"
      );
      return publicView(updated);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/integrations/:id",
    { preHandler: requireManage },
    async (req) => {
      db.prepare("DELETE FROM tabs WHERE integration_id = ?").run(req.params.id);
      db.prepare("DELETE FROM integrations WHERE id = ?").run(req.params.id);
      return { ok: true };
    }
  );

  // Connectivity test for an existing integration.
  app.post<{ Params: { id: string } }>(
    "/api/integrations/:id/test",
    { preHandler: requireManage },
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM integrations WHERE id = ?").get(req.params.id) as
        IntegrationRow | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      const adapter = getAdapter(row.type)!;
      try {
        return await adapter.test(rowToConfig(row));
      } catch (err: any) {
        return { ok: false, latencyMs: 0, message: err?.message ?? "connection failed" };
      }
    }
  );
}
