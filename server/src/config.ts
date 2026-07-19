import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cidrPrefixLength, isValidCidr } from "./lib/net.js";

// Restrictive defaults apply before the data directory, generated secrets, or
// SQLite sidecar files are created. Explicit chmod checks in db.ts enforce them
// for volumes created by older Harbor versions as well.
process.umask(0o077);
const dataDir = process.env.HARBOR_DATA || "./data";
fs.mkdirSync(dataDir, { recursive: true });
fs.chmodSync(dataDir, 0o700);

function loadPublicUrl(): string {
  const raw = (process.env.PUBLIC_URL || "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_URL must be an absolute http:// or https:// URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "PUBLIC_URL must be an http(s) origin without a path, credentials, query, or fragment"
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function loadSessionDays(): number {
  const value = process.env.SESSION_DAYS === undefined ? 7 : Number(process.env.SESSION_DAYS);
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error("SESSION_DAYS must be an integer from 1 through 90");
  }
  return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function csv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be true or false`);
  return raw === "true";
}

/**
 * HARBOR_SECRET signs sessions and encrypts integration secrets. If the
 * operator didn't set one, generate it once and persist it in the data dir
 * so sessions survive restarts.
 */
function loadSecret(): string {
  // Docker-secrets style: HARBOR_SECRET_FILE=/run/secrets/harbor_secret
  if (process.env.HARBOR_SECRET_FILE) {
    return fs.readFileSync(process.env.HARBOR_SECRET_FILE, "utf8").trim();
  }
  if (process.env.HARBOR_SECRET && process.env.HARBOR_SECRET !== "change-me") {
    return process.env.HARBOR_SECRET;
  }
  const file = path.join(dataDir, ".secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function loadOptionalSecretFile(name: string): string {
  const file = (process.env[name] || "").trim();
  if (!file) return "";
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 4_096)
    throw new Error(`${name} must name a regular file at most 4096 bytes`);
  return fs.readFileSync(file, "utf8").trim();
}

export const config = {
  appVersion: (process.env.HARBOR_VERSION || "0.1.0").trim(),
  port: boundedInteger("PORT", 9090, 1, 65_535),
  host: process.env.HOST || "0.0.0.0",
  dataDir,
  dbPath: path.join(dataDir, "harbor.db"),
  secret: loadSecret(),
  previousSecret: loadOptionalSecretFile("HARBOR_PREVIOUS_SECRET_FILE"),
  sessionDays: loadSessionDays(),
  publicUrl: loadPublicUrl(),
  setupToken: (process.env.HARBOR_SETUP_TOKEN || "").trim(),
  setupTokenFile: (
    process.env.HARBOR_SETUP_TOKEN_FILE || path.join(dataDir, ".setup-token")
  ).trim(),
  authProxy: {
    enabled: envBoolean("AUTH_PROXY", false),
    provider: (process.env.AUTH_PROXY_PROVIDER || "proxy").trim().toLowerCase(),
    headers: (
      process.env.AUTH_PROXY_HEADERS ||
      "Remote-User,X-Forwarded-User,X-Forwarded-Email,X-Auth-Request-Email"
    )
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    trusted: (process.env.AUTH_PROXY_TRUSTED || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  },
  adminUsers: (process.env.ADMIN_USERS || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean),
  outbound: {
    strictPrivate: envBoolean("HARBOR_OUTBOUND_STRICT_PRIVATE", false),
    allowCidrs: csv("HARBOR_OUTBOUND_ALLOW_CIDRS"),
    allowHosts: csv("HARBOR_OUTBOUND_ALLOW_HOSTS"),
    maxConcurrency: boundedInteger("HARBOR_OUTBOUND_MAX_CONCURRENCY", 12, 1, 64),
    perOriginConcurrency: boundedInteger("HARBOR_OUTBOUND_PER_ORIGIN", 4, 1, 16),
  },
  audit: {
    retentionDays: boundedInteger("HARBOR_AUDIT_RETENTION_DAYS", 180, 7, 3_650),
    maxRows: boundedInteger("HARBOR_AUDIT_MAX_ROWS", 20_000, 1_000, 100_000),
  },
  smtpCaFile: (process.env.HARBOR_SMTP_CA_FILE || "").trim(),
  webDist: process.env.HARBOR_WEB_DIST || "",
};

if (config.secret.length < 32 || config.secret.length > 4_096) {
  throw new Error("HARBOR_SECRET must contain 32-4096 characters");
}
if (!/^[0-9A-Za-z._+-]{1,64}$/.test(config.appVersion))
  throw new Error("HARBOR_VERSION must be 1-64 version-safe characters");
if (
  config.previousSecret &&
  (config.previousSecret.length < 32 || config.previousSecret.length > 4_096)
)
  throw new Error("HARBOR_PREVIOUS_SECRET_FILE must contain 32-4096 characters");
if (config.previousSecret && config.previousSecret === config.secret)
  throw new Error("HARBOR_PREVIOUS_SECRET_FILE must differ from the active HARBOR_SECRET");
if (!config.host || config.host.length > 253 || /[\s\r\n]/.test(config.host)) {
  throw new Error("HOST must be a valid bind hostname or address");
}
if (config.smtpCaFile) {
  const stat = fs.statSync(config.smtpCaFile);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("HARBOR_SMTP_CA_FILE must be a regular file at most 1 MiB");
}

const invalidOutboundCidrs = config.outbound.allowCidrs.filter((cidr) => !isValidCidr(cidr));
if (invalidOutboundCidrs.length > 0) {
  throw new Error(
    `HARBOR_OUTBOUND_ALLOW_CIDRS contains invalid CIDRs: ${invalidOutboundCidrs.join(",")}`
  );
}
const invalidOutboundHosts = config.outbound.allowHosts.filter(
  (host) =>
    host.length > 253 ||
    (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host !== "localhost")
);
if (invalidOutboundHosts.length > 0) {
  throw new Error(
    `HARBOR_OUTBOUND_ALLOW_HOSTS contains invalid hostnames: ${invalidOutboundHosts.join(",")}`
  );
}
if (config.outbound.perOriginConcurrency > config.outbound.maxConcurrency) {
  throw new Error("HARBOR_OUTBOUND_PER_ORIGIN cannot exceed HARBOR_OUTBOUND_MAX_CONCURRENCY");
}

if (config.authProxy.enabled) {
  if (!config.publicUrl) {
    throw new Error("AUTH_PROXY=true requires an explicit PUBLIC_URL");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(config.authProxy.provider)) {
    throw new Error("AUTH_PROXY_PROVIDER must be 1-32 lowercase letters, numbers, '.', '_' or '-'");
  }
  if (config.authProxy.trusted.length === 0) {
    throw new Error("AUTH_PROXY=true requires an explicit AUTH_PROXY_TRUSTED CIDR list");
  }
  const invalidTrust = config.authProxy.trusted.filter((cidr) => {
    const prefix = cidrPrefixLength(cidr);
    return prefix === null || prefix < 16;
  });
  if (invalidTrust.length > 0) {
    throw new Error(
      `AUTH_PROXY_TRUSTED must contain valid, narrowly scoped IPv4 CIDRs (/16 or narrower): ${invalidTrust.join(",")}`
    );
  }
  if (config.authProxy.headers.length === 0) {
    throw new Error("AUTH_PROXY=true requires at least one AUTH_PROXY_HEADERS value");
  }
  const forbiddenHeaders = new Set([
    "authorization",
    "cookie",
    "host",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]);
  const invalidHeaders = config.authProxy.headers.filter(
    (header) => !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(header) || forbiddenHeaders.has(header)
  );
  if (invalidHeaders.length > 0) {
    throw new Error(
      `AUTH_PROXY_HEADERS contains invalid or unsafe names: ${invalidHeaders.join(",")}`
    );
  }
  if (config.adminUsers.length === 0) {
    throw new Error("AUTH_PROXY=true requires at least one explicit ADMIN_USERS identity");
  }
}
