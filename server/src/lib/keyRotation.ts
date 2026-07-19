import { config } from "../config.js";
import { db } from "../db.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * When an operator mounts the previous master secret, rewrite every retained
 * field credential under the active key in one transaction. Startup fails and
 * rolls back if any value cannot be decrypted; sessions intentionally do not
 * accept the previous signing key.
 */
export function rotateStoredSecrets(): number {
  if (!config.previousSecret) return 0;
  return db.transaction(() => {
    let changed = 0;
    const rotate = (stored: string): string => {
      changed += 1;
      return encrypt(decrypt(stored));
    };
    const integrations = db
      .prepare("SELECT id, secret FROM integrations WHERE secret != ''")
      .all() as Array<{ id: number; secret: string }>;
    const updateIntegration = db.prepare("UPDATE integrations SET secret = ? WHERE id = ?");
    for (const row of integrations) updateIntegration.run(rotate(row.secret), row.id);

    const settingKeys = ["smtp_pass_enc"];
    const setting = db.prepare("SELECT value FROM settings WHERE key = ? AND value != ''");
    const updateSetting = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    for (const key of settingKeys) {
      const row = setting.get(key) as { value: string } | undefined;
      if (row) updateSetting.run(rotate(row.value), key);
    }

    const pushes = db
      .prepare("SELECT user_id, token_enc FROM user_push_endpoints WHERE token_enc != ''")
      .all() as Array<{ user_id: number; token_enc: string }>;
    const updatePush = db.prepare(
      "UPDATE user_push_endpoints SET token_enc = ?, updated_at = datetime('now') WHERE user_id = ?"
    );
    for (const row of pushes) updatePush.run(rotate(row.token_enc), row.user_id);

    db.prepare(
      `INSERT INTO audit_log
         (actor_username, action, status, detail_json)
       VALUES ('system', 'MASTER KEY rotation', 200, ?)`
    ).run(JSON.stringify({ ok: true, credentialsReencrypted: changed }));
    return changed;
  })();
}
