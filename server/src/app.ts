import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { databaseReady, schemaVersion, userCount } from "./db.js";
import { registerAuthHook } from "./auth/auth.js";
import { authRoutes } from "./auth/routes.js";
import { initializeSetupToken } from "./auth/setupToken.js";
import { ipTrusted } from "./lib/net.js";
import { tabRoutes } from "./routes/tabs.js";
import { integrationRoutes } from "./routes/integrations.js";
import { widgetRoutes } from "./routes/widgets.js";
import { settingsRoutes } from "./routes/settings.js";
import { groupRoutes } from "./routes/groups.js";
import { calendarRoutes } from "./routes/calendar.js";
import { notificationRoutes } from "./routes/notifications.js";
import { configRoutes } from "./routes/config.js";
import { monitorRoutes } from "./routes/monitors.js";
import { auditRoutes } from "./routes/audit.js";
import { recordAudit } from "./lib/audit.js";
import { requestLogShape } from "./lib/logging.js";
import { rotateStoredSecrets } from "./lib/keyRotation.js";

export interface BuildAppOptions {
  logger?: boolean;
  staticFiles?: boolean;
}

/** Build the API without listening, allowing the full security matrix to use Fastify injection. */
export async function buildApp(options: BuildAppOptions = {}) {
  rotateStoredSecrets();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL || "info",
            serializers: { req: requestLogShape },
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.authProxy.enabled
      ? (address: string) => ipTrusted(address, config.authProxy.trusted)
      : false,
  });

  initializeSetupToken(userCount() === 0, (message) => app.log.warn(message));
  await app.register(fastifyCookie, { secret: config.secret });

  app.addHook("onRequest", async (req, reply) => {
    if (req.raw.url && req.raw.url.length > 4_096)
      return reply.code(414).send({ error: "request target too long" });
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite === "cross-site")
      return reply.code(403).send({ error: "cross-site state change rejected" });
    const origin = req.headers.origin;
    if (!origin) return;
    // Preserve the Host header's explicit port for standalone deployments.
    // `req.hostname` intentionally strips it, which made legitimate browser
    // mutations fail on the default http://host:9090 deployment.
    const expected = config.publicUrl || `${req.protocol}://${req.headers.host || req.hostname}`;
    try {
      if (new URL(origin).origin !== new URL(expected).origin)
        return reply.code(403).send({ error: "request origin rejected" });
    } catch {
      return reply.code(403).send({ error: "request origin rejected" });
    }
  });

  app.addHook("preValidation", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (
      req.body !== undefined &&
      (req.body === null || typeof req.body !== "object" || Array.isArray(req.body))
    )
      return reply.code(400).send({ error: "JSON request body must be an object" });
    let nodes = 0;
    const backupImport = req.url === "/api/config/import" && !!req.user?.permissions.admin;
    const maxNodes = backupImport ? 250_000 : 10_000;
    const maxArray = backupImport ? 100_000 : 2_000;
    const inspect = (value: unknown, depth: number): boolean => {
      nodes += 1;
      if (nodes > maxNodes || depth > 12) return false;
      if (typeof value === "string") return value.length <= 512_000;
      if (Array.isArray(value))
        return value.length <= maxArray && value.every((item) => inspect(item, depth + 1));
      if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        return (
          entries.length <= 2_000 &&
          entries.every(
            ([key, item]) =>
              key.length <= 128 &&
              !["__proto__", "prototype", "constructor"].includes(key) &&
              inspect(item, depth + 1)
          )
        );
      }
      return value === null || ["number", "boolean", "undefined"].includes(typeof value);
    };
    if (!inspect(req.body, 0) || !inspect(req.query, 0))
      return reply.code(400).send({ error: "request structure exceeds allowed limits" });
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
      .header("Cross-Origin-Resource-Policy", "same-origin")
      .header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()"
      );
    if (!reply.hasHeader("Content-Security-Policy"))
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; frame-src http: https:"
      );
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control"))
      reply.header("Cache-Control", "no-store");
    if (config.publicUrl.startsWith("https://"))
      reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  app.get("/api/health/live", async () => ({ ok: true, name: "harbor" }));
  app.get("/api/health/ready", async (_req, reply) =>
    databaseReady()
      ? { ok: true, name: "harbor", schemaVersion }
      : reply.code(503).send({ ok: false, name: "harbor" })
  );
  app.get("/api/health", async (_req, reply) =>
    databaseReady()
      ? { ok: true, name: "harbor", schemaVersion }
      : reply.code(503).send({ ok: false, name: "harbor" })
  );
  registerAuthHook(app);
  app.addHook("onResponse", async (req, reply) => recordAudit(req, reply));
  authRoutes(app);
  tabRoutes(app);
  integrationRoutes(app);
  widgetRoutes(app);
  settingsRoutes(app);
  groupRoutes(app);
  calendarRoutes(app);
  notificationRoutes(app);
  configRoutes(app);
  monitorRoutes(app);
  auditRoutes(app);

  if (options.staticFiles !== false) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDist = config.webDist || path.resolve(here, "../../web/dist");
    if (fs.existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
        return reply.sendFile("index.html");
      });
    } else {
      app.log.warn(`web build not found at ${webDist} — API only (dev mode uses the Vite server)`);
    }
  }

  return app;
}
