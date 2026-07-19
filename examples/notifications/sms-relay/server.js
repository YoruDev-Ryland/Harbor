// SPDX-License-Identifier: MIT
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");

function value(name, options = {}) {
  const file = process.env[`${name}_FILE`];
  const raw = file ? fs.readFileSync(file, "utf8") : process.env[name];
  const result = raw?.trim() ?? "";
  if (options.required !== false && !result) throw new Error(`${name} is required`);
  return result;
}

function integer(name, fallback, min, max) {
  const raw = process.env[name] ?? String(fallback);
  const result = Number(raw);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

const SPACE = value("SIGNALWIRE_SPACE").toLowerCase();
const PROJECT = value("SIGNALWIRE_PROJECT_ID");
const TOKEN = value("SIGNALWIRE_API_TOKEN");
const FROM = value("SIGNALWIRE_FROM_NUMBER");
const API_KEY = value("RELAY_API_KEY");
const HOST = process.env.HOST?.trim() || "0.0.0.0";
const PORT = integer("PORT", 8080, 1, 65535);
const BODY_LIMIT = integer("REQUEST_BODY_LIMIT_BYTES", 16_384, 1024, 65_536);
const MESSAGE_LIMIT = integer("MAX_MESSAGE_CHARS", 480, 1, 1600);
const RATE_LIMIT = integer("RELAY_RATE_LIMIT_PER_MINUTE", 6, 1, 120);
const DAILY_LIMIT = integer("RELAY_DAILY_LIMIT", 100, 1, 10_000);
const UPSTREAM_TIMEOUT = integer("UPSTREAM_TIMEOUT_MS", 10_000, 1000, 30_000);
const MAX_CONCURRENT = integer("MAX_CONCURRENT_SENDS", 2, 1, 10);

if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.signalwire\.com$/.test(SPACE)) {
  throw new Error("SIGNALWIRE_SPACE must be a *.signalwire.com hostname");
}
if (!/^[A-Za-z0-9_-]{8,128}$/.test(PROJECT)) {
  throw new Error("SIGNALWIRE_PROJECT_ID has an invalid format");
}
if (TOKEN.length < 20) throw new Error("SIGNALWIRE_API_TOKEN must contain at least 20 characters");
if (API_KEY.length < 32) throw new Error("RELAY_API_KEY must contain at least 32 characters");
if (!isE164(FROM)) throw new Error("SIGNALWIRE_FROM_NUMBER must use E.164 format");

const allowAnyRecipient = process.env.SMS_ALLOW_ANY_RECIPIENT === "true";
const allowedRecipients = new Set(
  (process.env.SMS_ALLOWED_RECIPIENTS || "")
    .split(",")
    .map((number) => number.trim())
    .filter(Boolean)
);
for (const number of allowedRecipients) {
  if (!isE164(number)) throw new Error("SMS_ALLOWED_RECIPIENTS contains a non-E.164 number");
}
if (!allowAnyRecipient && allowedRecipients.size === 0) {
  throw new Error("SMS_ALLOWED_RECIPIENTS is required unless SMS_ALLOW_ANY_RECIPIENT=true");
}

const authHeader = `Basic ${Buffer.from(`${PROJECT}:${TOKEN}`).toString("base64")}`;
const upstreamUrl =
  `https://${SPACE}/api/laml/2010-04-01/Accounts/` + `${encodeURIComponent(PROJECT)}/Messages.json`;
const apiKeyBuffer = Buffer.from(API_KEY);

let minuteReservations = [];
let dailyDate = utcDate();
let dailyReservations = 0;
let inFlight = 0;

function isE164(number) {
  return /^\+[1-9]\d{7,14}$/.test(number);
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function authorized(req) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  const supplied = bearer || req.headers["x-api-key"];
  if (typeof supplied !== "string") return false;
  const candidate = Buffer.from(supplied.trim());
  return (
    candidate.length === apiKeyBuffer.length && crypto.timingSafeEqual(candidate, apiKeyBuffer)
  );
}

function reserveSend() {
  const now = Date.now();
  minuteReservations = minuteReservations.filter((timestamp) => timestamp > now - 60_000);
  if (minuteReservations.length >= RATE_LIMIT) throw httpError(429, "send rate limit reached");

  const today = utcDate();
  if (today !== dailyDate) {
    dailyDate = today;
    dailyReservations = 0;
  }
  if (dailyReservations >= DAILY_LIMIT) throw httpError(429, "daily send limit reached");

  minuteReservations.push(now);
  dailyReservations += 1;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > BODY_LIMIT) {
    req.resume();
    throw httpError(413, "request body too large");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw httpError(413, "request body too large");
    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw httpError(400, "request body must be a JSON object");
  }
}

async function readLimitedResponse(response, limit = 65_536) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("provider response exceeded the safe size limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function masked(number) {
  return `${number.slice(0, 3)}***${number.slice(-2)}`;
}

async function handle(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.url !== "/send") return sendJson(res, 404, { ok: false, error: "not found" });
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" }, { Allow: "POST" });
  }
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    return sendJson(res, 415, { ok: false, error: "content type must be application/json" });
  }
  if (inFlight >= MAX_CONCURRENT) {
    return sendJson(
      res,
      503,
      { ok: false, error: "relay is busy; retry later" },
      { "Retry-After": "2" }
    );
  }

  const payload = await readJson(req);
  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!isE164(to)) throw httpError(400, "to must use E.164 format");
  if (!allowAnyRecipient && !allowedRecipients.has(to))
    throw httpError(403, "recipient not allowed");
  if (!message) throw httpError(400, "message is required");
  if (message.length > MESSAGE_LIMIT) {
    throw httpError(400, `message exceeds ${MESSAGE_LIMIT} characters`);
  }
  if (message.includes("\0")) throw httpError(400, "message contains an invalid character");

  reserveSend();
  inFlight += 1;
  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "harbor-sms-relay/1.0",
      },
      body: new URLSearchParams({ To: to, From: FROM, Body: message }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    const raw = await readLimitedResponse(response);
    let provider = {};
    try {
      provider = JSON.parse(raw);
    } catch {
      // Provider errors are intentionally not reflected verbatim to callers or logs.
    }

    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "provider_rejected",
          requestId,
          status: response.status,
          code: provider.code ?? null,
        })
      );
      return sendJson(res, 502, {
        ok: false,
        error: "SMS provider rejected the request",
        requestId,
      });
    }

    console.log(
      JSON.stringify({
        event: "message_accepted",
        requestId,
        to: masked(to),
        sid: provider.sid ?? null,
      })
    );
    return sendJson(res, 202, {
      ok: true,
      sid: provider.sid ?? null,
      status: provider.status ?? "accepted",
      requestId,
    });
  } finally {
    inFlight -= 1;
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    if (status >= 500) {
      console.error(JSON.stringify({ event: "relay_error", error: error.name || "Error" }));
    }
    sendJson(res, status, {
      ok: false,
      error: status >= 500 ? "SMS relay request failed" : error.message,
    });
  });
});

server.maxHeadersCount = 50;
server.headersTimeout = 5000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      event: "listening",
      host: HOST,
      port: PORT,
      allowedRecipients: allowAnyRecipient ? "any-explicitly-enabled" : allowedRecipients.size,
      rateLimitPerMinute: RATE_LIMIT,
      dailyLimit: DAILY_LIMIT,
    })
  );
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
