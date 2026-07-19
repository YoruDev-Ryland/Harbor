import type { FastifyReply, FastifyRequest } from "fastify";

interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  includeUsername?: boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

/**
 * Small, dependency-free limiter for expensive authentication operations. It
 * Keys on Fastify's verified client IP. `trustProxy` is either disabled or a
 * narrow peer callback, so untrusted forwarding headers cannot choose this key.
 */
export function authRateLimit(options: RateLimitOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    if (buckets.size > MAX_BUCKETS) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      if (buckets.size > MAX_BUCKETS) buckets.clear();
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const username =
      options.includeUsername && typeof body.username === "string"
        ? `:${body.username.trim().toLowerCase().slice(0, 64)}`
        : "";
    const client = req.ip || req.raw.socket?.remoteAddress || "unknown";
    const key = `${options.name}:${client}${username}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.limit) {
      const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      reply.header("Retry-After", String(retry));
      return reply.code(429).send({ error: "too many attempts; try again later" });
    }
  };
}
