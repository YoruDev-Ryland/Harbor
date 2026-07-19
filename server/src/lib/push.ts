import { db } from "../db.js";
import { decrypt, encrypt } from "./crypto.js";
import type { NotifyKind } from "./notify.js";
import { safeFetch } from "./outbound.js";

export interface PushConfig {
  enabled: boolean;
  url: string;
  topic: string;
  token: string;
}

export function getUserPush(userId: number): PushConfig {
  const row = db
    .prepare("SELECT enabled, url, topic, token_enc FROM user_push_endpoints WHERE user_id = ?")
    .get(userId) as { enabled: number; url: string; topic: string; token_enc: string } | undefined;
  let token = "";
  let credentialUnreadable = false;
  if (row?.token_enc) {
    try {
      token = decrypt(row.token_enc);
    } catch {
      // A missing/changed master secret must not leak details or send unauthenticated.
      credentialUnreadable = true;
    }
  }
  return {
    enabled: !!row?.enabled && !credentialUnreadable,
    url: row?.url || "http://ntfy",
    topic: row?.topic || "",
    token,
  };
}

export function saveUserPush(
  userId: number,
  patch: Partial<PushConfig> & { clearToken?: boolean }
): { credentialCleared: boolean } {
  const current = getUserPush(userId);
  let currentOrigin = "";
  let nextOrigin = "";
  try {
    currentOrigin = new URL(current.url).origin;
  } catch {
    // Invalid legacy values lose their retained credential on the next save.
  }
  const nextUrl = patch.url?.trim().replace(/\/+$/, "") ?? current.url;
  try {
    nextOrigin = new URL(nextUrl).origin;
  } catch {
    // Route validation rejects this; keep the helper defensive for CLI/import use.
  }
  const clearToken = !!patch.clearToken || (!!current.token && nextOrigin !== currentOrigin);
  const tokenEnc = patch.token
    ? encrypt(patch.token)
    : clearToken
      ? ""
      : ((
          db.prepare("SELECT token_enc FROM user_push_endpoints WHERE user_id = ?").get(userId) as
            { token_enc: string } | undefined
        )?.token_enc ?? "");
  db.prepare(
    `INSERT INTO user_push_endpoints (user_id, enabled, url, topic, token_enc, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled, url = excluded.url, topic = excluded.topic,
       token_enc = excluded.token_enc, updated_at = datetime('now')`
  ).run(
    userId,
    (patch.enabled ?? current.enabled) ? 1 : 0,
    nextUrl,
    patch.topic?.trim() ?? current.topic,
    tokenEnc
  );
  return { credentialCleared: clearToken && !patch.token };
}

const PRIORITY: Record<NotifyKind, number> = { error: 5, warn: 4, success: 3, info: 3 };
const TAGS: Record<NotifyKind, string> = {
  error: "rotating_light",
  warn: "warning",
  success: "white_check_mark",
  info: "information_source",
};

export interface PushInput {
  kind: NotifyKind;
  title: string;
  body?: string;
  url?: string;
  urlLabel?: string;
}

async function publish(cfg: PushConfig, input: PushInput): Promise<void> {
  const payload: Record<string, unknown> = {
    topic: cfg.topic,
    title: input.title,
    message: input.body?.trim() || input.title,
    priority: PRIORITY[input.kind],
    tags: [TAGS[input.kind]],
  };
  if (input.url) {
    payload.click = input.url;
    payload.actions = [{ action: "view", label: input.urlLabel || "Open", url: input.url }];
  }
  const response = await safeFetch(
    cfg.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(payload),
    },
    10_000,
    { maxBytes: 16_384, maxRedirects: 0 }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`ntfy returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

/** Deliver only to this user's private endpoint. */
export async function sendUserPush(userId: number, input: PushInput): Promise<boolean> {
  const config = getUserPush(userId);
  if (!config.enabled || !config.url || !config.topic) return false;
  await publish(config, input);
  return true;
}

export async function testUserPush(userId: number, siteTitle = "Harbor"): Promise<void> {
  const config = getUserPush(userId);
  if (!config.url || !config.topic) throw new Error("Set your ntfy server URL and topic first");
  await publish(config, {
    kind: "success",
    title: `${siteTitle} push is working`,
    body: "This private notification endpoint belongs to your Harbor account.",
  });
}
