import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { closeDatabase, db, databaseReady, schemaVersion } from "./db.js";
import { hashRecoveryToken } from "./lib/crypto.js";

function usage(): never {
  console.error(
    "Usage: node server/dist/cli.js <status|reset-password|revoke-sessions> [username]"
  );
  process.exitCode = 2;
  throw new Error("invalid command");
}

function findUser(username: string | undefined): {
  id: number;
  username: string;
  disabled: number;
} {
  if (!username) return usage();
  const user = db
    .prepare("SELECT id, username, disabled FROM users WHERE username = ?")
    .get(username) as { id: number; username: string; disabled: number } | undefined;
  if (!user) throw new Error("account not found");
  return user;
}

try {
  const [command, username] = process.argv.slice(2);
  if (command === "status") {
    const users = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number })
      .count;
    console.log(JSON.stringify({ ready: databaseReady(), schemaVersion, users }));
  } else if (command === "reset-password") {
    const user = findUser(username);
    if (user.disabled) throw new Error("enable the account before issuing a reset");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 15 * 60_000;
    db.transaction(() => {
      db.prepare(
        "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
      ).run(user.id);
      db.prepare(
        "INSERT INTO password_resets (user_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, NULL)"
      ).run(user.id, hashRecoveryToken(token), expiresAt);
      db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(
        user.id
      );
      db.prepare(
        `INSERT INTO audit_log
           (actor_username, action, target, status, detail_json)
         VALUES ('container-cli', 'CLI reset-password', ?, 200, '{"ok":true}')`
      ).run(`user:${user.id}`);
    })();
    const path = `/reset-password?token=${encodeURIComponent(token)}`;
    console.log(config.publicUrl ? `${config.publicUrl}${path}` : path);
    console.error(
      `One-time reset for ${user.username}; expires ${new Date(expiresAt).toISOString()}`
    );
  } else if (command === "revoke-sessions") {
    const user = findUser(username);
    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(user.id);
    db.prepare(
      `INSERT INTO audit_log
         (actor_username, action, target, status, detail_json)
       VALUES ('container-cli', 'CLI revoke-sessions', ?, 200, '{"ok":true}')`
    ).run(`user:${user.id}`);
    console.log(`Revoked sessions for ${user.username}`);
  } else {
    usage();
  }
} catch (error: any) {
  if (process.exitCode !== 2) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
} finally {
  closeDatabase();
}
