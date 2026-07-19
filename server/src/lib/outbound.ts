import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_QUEUE = 200;

function addCidr(list: BlockList, cidr: string): void {
  const slash = cidr.lastIndexOf("/");
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  const prefix = slash === -1 ? (family === "ipv6" ? 128 : 32) : Number(cidr.slice(slash + 1));
  list.addSubnet(address, prefix, family);
}

const operatorAllow = new BlockList();
for (const cidr of config.outbound.allowCidrs) addCidr(operatorAllow, cidr);

function addressFamily(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 6 ? "ipv6" : "ipv4";
}

function hostnameAllowed(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return config.outbound.allowHosts.some((allowed) =>
    allowed.startsWith("*.")
      ? normalized.endsWith(allowed.slice(1)) && normalized !== allowed.slice(2)
      : normalized === allowed
  );
}

export function assertResolvedAddressAllowed(hostname: string, address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
    }
  } catch {
    throw new Error(`outbound destination ${hostname} resolved to an invalid address`);
  }
  const normalized = parsed.toString();
  const family = addressFamily(normalized);
  const range = parsed.range();
  const privateRange =
    range === "private" || range === "uniqueLocal" || range === "carrierGradeNat";
  if (range !== "unicast" && !privateRange) {
    throw new Error(`outbound destination ${hostname} resolved to a blocked special-use address`);
  }
  if (
    privateRange &&
    config.outbound.strictPrivate &&
    !operatorAllow.check(normalized, family) &&
    !hostnameAllowed(hostname)
  ) {
    throw new Error(
      `outbound destination ${hostname} resolved to a private address not permitted by the strict outbound allow-list`
    );
  }
}

/** Resolve and validate a non-HTTP service host (currently SMTP). */
export async function resolveOutboundHost(hostname: string): Promise<string> {
  const normalized = hostname.trim().replace(/^\[|\]$/g, "");
  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await dns.promises.lookup(normalized, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`outbound destination ${hostname} did not resolve`);
  for (const item of addresses) assertResolvedAddressAllowed(normalized, item.address);
  return addresses[0].address;
}

export function parseOutboundUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("outbound URL must be absolute");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error("outbound URL must be credential-free HTTP(S) without a fragment");
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) assertResolvedAddressAllowed(literal, literal);
  return url;
}

const dispatcher = new Agent({
  connections: config.outbound.perOriginConcurrency,
  pipelining: 1,
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        try {
          if (addresses.length === 0)
            throw new Error(`outbound destination ${hostname} did not resolve`);
          for (const item of addresses) assertResolvedAddressAllowed(hostname, item.address);
          if (typeof options === "object" && options.all) {
            (callback as any)(null, addresses);
          } else {
            const wantedFamily =
              typeof options === "object" ? Number(options.family) || 0 : Number(options) || 0;
            const selected =
              addresses.find((item) => !wantedFamily || item.family === wantedFamily) ??
              addresses[0];
            callback(null, selected.address, selected.family);
          }
        } catch (err) {
          callback(err as Error, "", 4);
        }
      });
    },
  },
});

let active = 0;
const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

async function acquire(): Promise<() => void> {
  if (active < config.outbound.maxConcurrency) {
    active += 1;
    return release;
  }
  if (waiters.length >= MAX_QUEUE) throw new Error("outbound request budget exhausted");
  await new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
  active += 1;
  return release;
}

function release(): void {
  active = Math.max(0, active - 1);
  waiters.shift()?.resolve();
}

export async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`upstream response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function withoutSensitiveHeaders(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"])
    headers.delete(name);
  return { ...init, headers };
}

function redirectedToGet(init: RequestInit): RequestInit {
  const next = withoutSensitiveHeaders({ ...init, method: "GET", body: undefined });
  const headers = new Headers(next.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return { ...next, headers };
}

export interface OutboundOptions {
  maxBytes?: number;
  maxRedirects?: number;
  discardBody?: boolean;
}

/**
 * Fetch through Harbor's SSRF boundary. DNS is validated by the connector used
 * for the actual socket, redirects are validated one hop at a time, and the
 * decompressed response is fully bounded before it reaches an adapter.
 */
export async function safeFetch(
  input: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
  options: OutboundOptions = {}
): Promise<Response> {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 16 * 1024 * 1024));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS));
  const releaseSlot = await acquire();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, 60_000)));
  let current = parseOutboundUrl(input);
  let requestInit = init;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await undiciFetch(current, {
        ...(requestInit as Dispatcher.RequestOptions),
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      } as any);
      const location = response.headers.get("location");
      if (
        location &&
        response.status >= 300 &&
        response.status < 400 &&
        init.redirect !== "manual"
      ) {
        if (redirects >= maxRedirects) {
          await response.body?.cancel();
          throw new Error("outbound redirect limit exceeded");
        }
        const next = parseOutboundUrl(new URL(location, current).toString());
        if (next.origin !== current.origin) requestInit = withoutSensitiveHeaders(requestInit);
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            requestInit.method?.toUpperCase() === "POST")
        ) {
          requestInit = redirectedToGet(requestInit);
        }
        await response.body?.cancel();
        current = next;
        continue;
      }
      if (options.discardBody) {
        await response.body?.cancel();
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const body = await readLimitedBody(response as unknown as Response, maxBytes);
      return new Response(Buffer.from(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  } finally {
    clearTimeout(timeout);
    releaseSlot();
  }
}
