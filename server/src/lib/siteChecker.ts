import { db } from "../db.js";
import { fetchRaw } from "../modules/types.js";
import { notify } from "./notify.js";

/**
 * Smart website monitoring — more than a ping. For each site we look at the HTTP
 * status, scan the body for well-known failure signatures (a WordPress fatal
 * error, a DB-connection error, gateway errors, …), require an optional keyword
 * to be present, and flag suspicious content shrink versus a learned healthy
 * baseline (a crashed CMS usually serves a tiny error page instead of the site).
 */

export type SiteState = "up" | "changed" | "error" | "down";

export interface MonitorRow {
  id: number;
  name: string;
  url: string;
  enabled: number;
  expect_status: number | null;
  keyword: string | null;
  baseline_len: number | null;
  last_state: SiteState | null;
}

export interface CheckResult {
  state: SiteState;
  status: number;
  latency: number;
  message: string;
  len: number;
}

// substrings that indicate a broken page even when the status is 200
const ERROR_SIGNATURES = [
  "error establishing a database connection",
  "there has been a critical error on this website",
  "fatal error",
  "500 internal server error",
  "502 bad gateway",
  "503 service temporarily unavailable",
  "503 service unavailable",
  "504 gateway timeout",
  "web server is down",
  "error 521",
  "error 522",
  "error 523",
  "this site can’t be reached",
];

const BODY_CAP = 200_000; // only scan the first ~200KB
const SHRINK_RATIO = 0.4; // < 40% of the healthy size is treated as a likely crash

export async function checkMonitor(m: MonitorRow): Promise<CheckResult> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchRaw(
      m.url,
      { method: "GET", redirect: "follow", headers: { "User-Agent": "Harbor-Monitor/1.0" } },
      12_000,
      { maxBytes: BODY_CAP }
    );
  } catch (err: any) {
    return {
      state: "down",
      status: 0,
      latency: Date.now() - t0,
      message: err?.message ?? "unreachable",
      len: 0,
    };
  }
  const latency = Date.now() - t0;
  const status = res.status;

  let body = "";
  try {
    body = (await res.text()).slice(0, BODY_CAP);
  } catch {
    /* non-text/binary body — status checks still apply */
  }
  const low = body.toLowerCase();
  const err = (message: string): CheckResult => ({
    state: "error",
    status,
    latency,
    message,
    len: body.length,
  });

  if (m.expect_status && status !== m.expect_status)
    return err(`expected HTTP ${m.expect_status}, got ${status}`);
  if (!m.expect_status && status >= 400) return err(`HTTP ${status}`);

  const sig = ERROR_SIGNATURES.find((s) => low.includes(s));
  if (sig) return err(`page shows “${sig}”`);

  if (m.keyword && !body.includes(m.keyword)) return err(`missing expected text “${m.keyword}”`);

  if (m.baseline_len && body.length > 0 && body.length < m.baseline_len * SHRINK_RATIO) {
    const pct = Math.round((1 - body.length / m.baseline_len) * 100);
    return {
      state: "changed",
      status,
      latency,
      message: `content shrank ${pct}% — possible crash`,
      len: body.length,
    };
  }

  return { state: "up", status, latency, message: "OK", len: body.length };
}

function notifyTransition(m: MonitorRow, r: CheckResult): void {
  const prev = m.last_state;
  if (!prev || prev === r.state) return; // seeding or no change
  const wasBad = prev === "error" || prev === "down";
  const isBad = r.state === "error" || r.state === "down";

  const fields = [
    { label: "Site", value: m.name },
    { label: "URL", value: m.url },
    { label: "Status", value: r.status ? `HTTP ${r.status}` : "unreachable" },
    { label: "Latency", value: `${r.latency} ms` },
    { label: "Detail", value: r.message },
  ];
  const common = { category: "websites" as const, fields, url: m.url, urlLabel: "Open site" };

  if (isBad && !wasBad)
    void notify({ kind: "error", title: `${m.name} is ${r.state}`, body: r.message, ...common });
  else if (!isBad && wasBad)
    void notify({
      kind: "success",
      title: `${m.name} recovered`,
      body: `${m.url} is healthy again.`,
      ...common,
    });
  else if (r.state === "changed" && prev === "up")
    void notify({ kind: "warn", title: `${m.name} changed`, body: r.message, ...common });
}

export async function runAndStore(m: MonitorRow): Promise<CheckResult> {
  const r = await checkMonitor(m);
  const ok = r.state === "up" || r.state === "changed";

  notifyTransition(m, r);

  // learn/refresh the healthy baseline only when the page looks genuinely up
  const nextBaseline = r.state === "up" && r.len > 0 ? r.len : m.baseline_len;
  db.prepare(
    `UPDATE monitors SET last_state = ?, last_status = ?, last_latency = ?, last_message = ?,
     last_checked = datetime('now'), baseline_len = ? WHERE id = ?`
  ).run(r.state, r.status, r.latency, r.message, nextBaseline ?? null, m.id);

  db.prepare(
    "INSERT INTO monitor_history (monitor_id, ok, status, latency) VALUES (?, ?, ?, ?)"
  ).run(m.id, ok ? 1 : 0, r.status, r.latency);
  db.prepare(
    "DELETE FROM monitor_history WHERE monitor_id = ? AND checked_at < datetime('now', '-3 days')"
  ).run(m.id);
  return r;
}

const SELECT_MONITOR =
  "SELECT id, name, url, enabled, expect_status, keyword, baseline_len, last_state FROM monitors";

export async function checkAllMonitors(): Promise<void> {
  const rows = db.prepare(`${SELECT_MONITOR} WHERE enabled = 1`).all() as MonitorRow[];
  await Promise.allSettled(rows.map((m) => runAndStore(m)));
}

export function checkOne(id: number): Promise<CheckResult> {
  const row = db.prepare(`${SELECT_MONITOR} WHERE id = ?`).get(id) as MonitorRow | undefined;
  if (!row) throw new Error("monitor not found");
  return runAndStore(row);
}
