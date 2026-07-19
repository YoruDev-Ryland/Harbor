import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.js";

const deriveKey = (root: string, purpose: string): Buffer =>
  Buffer.from(
    hkdfSync("sha256", Buffer.from(root), Buffer.from("harbor-v2"), Buffer.from(purpose), 32)
  );
const encKey = deriveKey(config.secret, "field-encryption");
const sessionKey = deriveKey(config.secret, "session-signing");
const previousEncKey = config.previousSecret
  ? deriveKey(config.previousSecret, "field-encryption")
  : null;
const legacyEncKeys = [
  scryptSync(config.secret, "harbor-enc", 32),
  ...(config.previousSecret ? [scryptSync(config.previousSecret, "harbor-enc", 32)] : []),
];

// ── password hashing (scrypt) ───────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex || saltHex.length !== 32 || hashHex.length !== 128) return false;
    const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// ── secret storage (AES-256-GCM) — integration API keys at rest ─────

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const parts = stored.split(":");
  const versioned = parts[0] === "v2";
  const [ivHex, tagHex, dataHex] = versioned ? parts.slice(1) : parts;
  if (!ivHex || !tagHex || !dataHex) return "";
  const keys = versioned ? [encKey, ...(previousEncKey ? [previousEncKey] : [])] : legacyEncKeys;
  let lastError: unknown;
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataHex, "hex")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("encrypted value could not be decrypted");
}

// ── stateless signed session tokens ─────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", sessionKey).update(payload).digest("base64url");
}

export function createSessionToken(userId: number, sessionVersion: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      ver: sessionVersion,
      exp: Date.now() + config.sessionDays * 86_400_000,
    })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export interface VerifiedSession {
  userId: number;
  sessionVersion: number;
}

export function verifySessionToken(token: string): VerifiedSession | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof data.uid !== "number" ||
      typeof data.ver !== "number" ||
      typeof data.exp !== "number"
    )
      return null;
    if (Date.now() > data.exp) return null;
    return { userId: data.uid, sessionVersion: data.ver };
  } catch {
    return null;
  }
}

/** Store recovery tokens as one-way digests so a database read cannot use them. */
export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** One-way lookup for bearer tokens that never need to be shown again. */
export const hashBearerToken = hashRecoveryToken;

/** Non-secret compatibility marker included in sensitive backups. */
export function secretFingerprint(): string {
  return createHmac("sha256", encKey).update("harbor-backup-key-v1").digest("hex").slice(0, 32);
}
