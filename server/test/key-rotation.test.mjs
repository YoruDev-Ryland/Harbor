import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-key-rotation-test-"));
const previousFile = path.join(dataDir, "previous.secret");
const oldSecret = "example-old-master-secret-that-is-at-least-32-characters";
const newSecret = "example-new-master-secret-that-is-at-least-32-characters";
fs.writeFileSync(previousFile, oldSecret, { mode: 0o600 });

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function child(source, secret, previous = "") {
  const env = { ...process.env, HARBOR_DATA: dataDir, HARBOR_SECRET: secret, AUTH_PROXY: "false" };
  if (previous) env.HARBOR_PREVIOUS_SECRET_FILE = previous;
  else delete env.HARBOR_PREVIOUS_SECRET_FILE;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("planned master-key rotation is transactional and leaves current-key ciphertext", () => {
  child(
    `
      const { db, closeDatabase } = await import('./server/dist/db.js');
      const { encrypt } = await import('./server/dist/lib/crypto.js');
      db.prepare("INSERT INTO integrations (type, name, url, secret) VALUES ('sonarr', 'rotating', 'https://one.example.test', ?)").run(encrypt('integration-secret'));
      db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass_enc', ?)").run(encrypt('smtp-secret'));
      closeDatabase();
    `,
    oldSecret
  );
  child(
    `
      const { db, closeDatabase } = await import('./server/dist/db.js');
      const { decrypt } = await import('./server/dist/lib/crypto.js');
      const { rotateStoredSecrets } = await import('./server/dist/lib/keyRotation.js');
      if (rotateStoredSecrets() !== 2) throw new Error('unexpected rotation count');
      if (decrypt(db.prepare("SELECT secret FROM integrations WHERE name = 'rotating'").get().secret) !== 'integration-secret') throw new Error('integration decrypt failed');
      if (decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass_enc'").get().value) !== 'smtp-secret') throw new Error('SMTP decrypt failed');
      closeDatabase();
    `,
    newSecret,
    previousFile
  );
  child(
    `
      const { db, closeDatabase } = await import('./server/dist/db.js');
      const { decrypt } = await import('./server/dist/lib/crypto.js');
      const values = [db.prepare("SELECT secret FROM integrations WHERE name = 'rotating'").get().secret, db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass_enc'").get().value].map(decrypt);
      if (values.join(',') !== 'integration-secret,smtp-secret') throw new Error('current key could not decrypt rotated values');
      closeDatabase();
    `,
    newSecret
  );
});
