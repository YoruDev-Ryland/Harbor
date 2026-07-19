/** CIDR containment check for IPv4 (and IPv4-mapped IPv6) addresses. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = normalize(ip);
  if (!addr) return false;
  const [range] = cidr.split("/");
  const rangeAddr = normalize(range ?? "");
  if (rangeAddr === null) return false;
  const bits = cidrPrefixLength(cidr);
  if (bits === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (rangeAddr & mask);
}

/** Return a valid IPv4 CIDR prefix length, or null for malformed input. */
export function cidrPrefixLength(cidr: string): number | null {
  const parts = cidr.split("/");
  if (parts.length > 2 || normalize(parts[0] ?? "") === null) return null;
  const bits = parts[1] === undefined ? 32 : Number(parts[1]);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32 ? bits : null;
}

export function ipTrusted(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/** Validate an IPv4 or IPv6 CIDR without accepting hostnames or shorthand prefixes. */
export function isValidCidr(cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  const family = isIP(address);
  if (!family) return false;
  if (slash === -1) return true;
  const rawPrefix = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(rawPrefix)) return false;
  const prefix = Number(rawPrefix);
  return prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

function normalize(ip: string): number | null {
  let v4 = ip.trim();
  if (v4.startsWith("::ffff:")) v4 = v4.slice(7);
  if (v4 === "::1") v4 = "127.0.0.1";
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}
import { isIP } from "node:net";
