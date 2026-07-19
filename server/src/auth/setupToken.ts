import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";

const MIN_TOKEN_LENGTH = 32;
let activeToken = "";
let managedTokenFile = false;

function validToken(token: string): string {
  const value = token.trim();
  if (value.length < MIN_TOKEN_LENGTH || value.length > 256) {
    throw new Error(`Harbor setup tokens must contain ${MIN_TOKEN_LENGTH}-256 characters`);
  }
  return value;
}

/** Initialize the one-time first-run token before the server begins listening. */
export function initializeSetupToken(
  setupRequired: boolean,
  logGenerated: (message: string) => void
): void {
  if (!setupRequired) {
    // Clean up a generated token left behind if the first user was provisioned
    // through SSO or the database was restored between starts.
    if (!process.env.HARBOR_SETUP_TOKEN_FILE && fs.existsSync(config.setupTokenFile)) {
      fs.unlinkSync(config.setupTokenFile);
    }
    return;
  }

  if (config.setupToken) {
    activeToken = validToken(config.setupToken);
    return;
  }

  if (fs.existsSync(config.setupTokenFile)) {
    activeToken = validToken(fs.readFileSync(config.setupTokenFile, "utf8"));
    // The default data-directory token is managed by Harbor. Docker secret files are not.
    managedTokenFile = !process.env.HARBOR_SETUP_TOKEN_FILE;
    if (managedTokenFile) fs.chmodSync(config.setupTokenFile, 0o600);
    return;
  }

  if (process.env.HARBOR_SETUP_TOKEN_FILE) {
    throw new Error(`HARBOR_SETUP_TOKEN_FILE does not exist: ${config.setupTokenFile}`);
  }

  activeToken = randomBytes(24).toString("base64url");
  fs.writeFileSync(config.setupTokenFile, `${activeToken}\n`, { mode: 0o600, flag: "wx" });
  managedTokenFile = true;
  logGenerated(`First-run setup token: ${activeToken} (also stored at ${config.setupTokenFile})`);
}

export function verifySetupToken(candidate: unknown): boolean {
  if (!activeToken || typeof candidate !== "string" || candidate.length > 256) return false;
  const supplied = Buffer.from(candidate.trim());
  const expected = Buffer.from(activeToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Make the token unusable in this process and remove Harbor's generated token file. */
export function consumeSetupToken(): void {
  activeToken = "";
  if (managedTokenFile) {
    try {
      fs.unlinkSync(config.setupTokenFile);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
