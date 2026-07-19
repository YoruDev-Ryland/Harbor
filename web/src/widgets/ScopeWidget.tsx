import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  Cloud,
  Compass,
  Crosshair,
  Filter as FilterIcon,
  Focus,
  Image as ImageIcon,
  Telescope,
} from "lucide-react";
import { api } from "../api";
import type { ScopeStatus, ScopeResponse } from "../types";
import type { WidgetProps } from "./registry";

/** The rig's headline activity, in priority order — what's it doing right now. */
function activity(s: ScopeStatus): { label: string; cls: string } {
  if (!s.anyConnected) return { label: "No equipment connected", cls: "idle" };
  if (s.mount?.slewing) return { label: "Slewing", cls: "busy" };
  if (s.camera?.exposing) return { label: "Exposing", cls: "expose" };
  if (s.filterWheel?.moving) return { label: "Changing filter", cls: "busy" };
  if (s.focuser?.moving) return { label: "Focusing", cls: "busy" };
  if (s.mount?.atPark) return { label: "Parked", cls: "park" };
  if (s.mount?.atHome) return { label: "At home", cls: "park" };
  if (s.mount?.tracking) return { label: "Tracking", cls: "track" };
  return { label: "Idle", cls: "idle" };
}

/** ISO end time → live-ish "4m 12s" remaining (null once elapsed/unknown). */
function remaining(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** decimal hours → "1h 23m" / "23m" (null when ≤0 or unknown). */
function hoursToHm(h?: number): string | null {
  if (h == null || !Number.isFinite(h) || h <= 0) return null;
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

function temp(c?: number, digits = 1): string {
  return c == null ? "—" : `${c.toFixed(digits)}°C`;
}

/** guiding quality bands: <1″ good, <2″ marginal, else poor */
function rmsClass(v?: number): string {
  if (v == null) return "none";
  if (v < 1) return "ok";
  if (v < 2) return "warn";
  return "hot";
}

/** PHD-style guiding graph: RA and Dec error in arcsec around a zero baseline. */
function GuideGraph({
  history,
  rmsRa,
  rmsDec,
  rmsTotal,
}: {
  history: Array<{ ra: number; dec: number }>;
  rmsRa?: number;
  rmsDec?: number;
  rmsTotal?: number;
}) {
  const n = history.length;
  const w = 240;
  const h = 96;
  const padY = 6;
  // symmetric scale, but never zoom in past ±1″ so tiny errors don't look wild
  const maxAbs = history.reduce((m, p) => Math.max(m, Math.abs(p.ra), Math.abs(p.dec)), 0);
  const M = Math.max(1, maxAbs) * 1.1;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => padY + (1 - (v + M) / (2 * M)) * (h - 2 * padY);
  const pathOf = (key: "ra" | "dec") =>
    history
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join(" ");

  return (
    <div className="scope-guide">
      <div className="scope-guide-head">
        <span className="scope-tile-label">
          <Crosshair size={12} />
          <span>Guiding</span>
        </span>
        <span className="scope-guide-legend">
          {rmsRa != null && <span className="lg-ra">RA {rmsRa.toFixed(2)}″</span>}
          {rmsDec != null && <span className="lg-dec">Dec {rmsDec.toFixed(2)}″</span>}
          {rmsTotal != null && <span className="lg-total">Σ {rmsTotal.toFixed(2)}″</span>}
        </span>
      </div>
      <svg
        className="scope-guide-svg"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line className="scope-guide-zero" x1="0" y1={y(0)} x2={w} y2={y(0)} />
        <path className="scope-guide-ra" d={pathOf("ra")} />
        <path className="scope-guide-dec" d={pathOf("dec")} />
      </svg>
      <div className="scope-guide-scale">±{M.toFixed(1)}″</div>
    </div>
  );
}

/** Latest-frame preview, streamed through the server proxy. Hides itself if the
 *  image can't be produced (e.g. no capture yet, or thumbnails disabled + no fallback). */
function ScopeShot({
  sourceId,
  index,
  caption,
}: {
  sourceId: number;
  index: number;
  caption: string;
}) {
  const [failed, setFailed] = useState(false);
  // reset the error state when a new frame arrives
  useEffect(() => setFailed(false), [index]);
  if (failed) return null;
  const src = `/api/widgets/scope/image?source=${sourceId}&index=${index}`;
  return (
    <figure className="scope-shot">
      <img src={src} alt="Latest capture" loading="lazy" onError={() => setFailed(true)} />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function Tile({
  icon,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="scope-tile">
      <div className="scope-tile-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`scope-tile-value${valueClass ? ` ${valueClass}` : ""}`}>{value}</div>
      {sub != null && sub !== "" && <div className="scope-tile-sub">{sub}</div>}
    </div>
  );
}

function ScopeCard({ s, showName }: { s: ScopeStatus; showName?: boolean }) {
  const act = activity(s);
  const flip = s.mount?.tracking ? hoursToHm(s.mount.meridianFlipHours) : null;
  const exp = s.camera?.exposing ? remaining(s.camera.exposureEndTime) : null;
  const coords =
    s.mount?.raString && s.mount?.decString ? `${s.mount.raString}  ${s.mount.decString}` : null;

  const detail = exp
    ? `${exp} left${s.filterWheel?.filter ? ` · ${s.filterWheel.filter}` : ""}`
    : flip
      ? `Meridian flip in ${flip}`
      : coords;

  return (
    <div className="scope-card">
      {showName && s.source.name && <div className="scope-name">{s.source.name}</div>}

      <div className={`scope-headline act-${act.cls}`}>
        <span className="scope-act">
          <span className={`scope-act-dot act-${act.cls}`} />
          {act.label}
        </span>
        {detail && <span className="scope-act-detail">{detail}</span>}
      </div>

      {(s.lastImage?.index != null || (s.guider?.history && s.guider.history.length > 1)) && (
        <div className="scope-media">
          {s.lastImage?.index != null && (
            <ScopeShot
              sourceId={s.source.id}
              index={s.lastImage.index}
              caption={[
                s.lastImage.filter,
                s.lastImage.exposureSeconds != null
                  ? `${Math.round(s.lastImage.exposureSeconds)}s`
                  : null,
                s.lastImage.hfr != null ? `${s.lastImage.hfr.toFixed(2)} HFR` : null,
                s.lastImage.stars != null ? `${s.lastImage.stars}★` : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            />
          )}
          {s.guider?.history && s.guider.history.length > 1 && (
            <GuideGraph
              history={s.guider.history}
              rmsRa={s.guider.rmsRaArcsec}
              rmsDec={s.guider.rmsDecArcsec}
              rmsTotal={s.guider.rmsTotalArcsec}
            />
          )}
        </div>
      )}

      {s.anyConnected && (
        <div className="scope-grid">
          {s.camera && (
            <Tile
              icon={<Camera size={12} />}
              label="Camera"
              value={temp(s.camera.temperatureC)}
              sub={
                s.camera.coolerOn
                  ? `→ ${s.camera.targetTempC != null ? `${Math.round(s.camera.targetTempC)}°` : "set"}${
                      s.camera.coolerPowerPct != null
                        ? ` · ${Math.round(s.camera.coolerPowerPct)}%`
                        : ""
                    }`
                  : "cooler off"
              }
            />
          )}

          {s.mount && (
            <Tile
              icon={<Compass size={12} />}
              label="Mount"
              value={coords ?? (s.mount.atPark ? "Parked" : "—")}
              sub={
                s.mount.altitude != null
                  ? `Alt ${Math.round(s.mount.altitude)}°${
                      s.mount.azimuth != null ? ` · Az ${Math.round(s.mount.azimuth)}°` : ""
                    }`
                  : undefined
              }
              valueClass="mono-sm"
            />
          )}

          {s.guider && !(s.guider.history && s.guider.history.length > 1) && (
            <Tile
              icon={<Crosshair size={12} />}
              label="Guiding"
              value={
                s.guider.rmsTotalArcsec != null
                  ? `${s.guider.rmsTotalArcsec.toFixed(2)}″`
                  : (s.guider.state ?? "—")
              }
              valueClass={`rms-${rmsClass(s.guider.rmsTotalArcsec)}`}
              sub={
                s.guider.rmsRaArcsec != null && s.guider.rmsDecArcsec != null
                  ? `RA ${s.guider.rmsRaArcsec.toFixed(2)} · Dec ${s.guider.rmsDecArcsec.toFixed(2)}`
                  : s.guider.state
              }
            />
          )}

          {s.filterWheel && (
            <Tile
              icon={<FilterIcon size={12} />}
              label="Filter"
              value={s.filterWheel.filter ?? "—"}
              sub={s.filterWheel.moving ? "changing…" : undefined}
            />
          )}

          {s.focuser && (
            <Tile
              icon={<Focus size={12} />}
              label="Focuser"
              value={s.focuser.position != null ? s.focuser.position.toLocaleString() : "—"}
              sub={
                s.focuser.temperatureC != null
                  ? `${temp(s.focuser.temperatureC)}${s.focuser.moving ? " · moving" : ""}`
                  : s.focuser.moving
                    ? "moving"
                    : undefined
              }
              valueClass="mono-sm"
            />
          )}

          {s.weather && (
            <Tile
              icon={<Cloud size={12} />}
              label="Weather"
              value={temp(s.weather.temperatureC, 0)}
              sub={[
                s.weather.humidityPct != null ? `${Math.round(s.weather.humidityPct)}% RH` : null,
                s.weather.cloudCoverPct != null
                  ? `${Math.round(s.weather.cloudCoverPct)}% cloud`
                  : null,
                s.weather.windSpeedMs != null ? `${s.weather.windSpeedMs.toFixed(1)} m/s` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}

          {s.lastImage && (s.lastImage.hfr != null || s.lastImage.stars != null) && (
            <Tile
              icon={<ImageIcon size={12} />}
              label="Last frame"
              value={
                s.lastImage.hfr != null
                  ? `${s.lastImage.hfr.toFixed(2)} HFR`
                  : `${s.lastImage.stars} stars`
              }
              sub={[
                s.lastImage.stars != null && s.lastImage.hfr != null
                  ? `${s.lastImage.stars} stars`
                  : null,
                s.lastImage.filter,
                s.lastImage.exposureSeconds != null
                  ? `${Math.round(s.lastImage.exposureSeconds)}s`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function ScopeWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "scope"],
    queryFn: () => api.get<ScopeResponse>("/api/widgets/scope"),
    refetchInterval: 6000,
  });

  const scopes = data?.scopes ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Telescope size={12} />
          <span>Telescope</span>
        </span>
        {scopes.length > 1 && <span className="panel-meta">{scopes.length}</span>}
      </header>

      <div className="widget-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Contacting the observatory…</div>
        ) : scopes.length === 0 ? (
          <div className="widget-empty">
            No telescope reporting. Add NINA (Advanced API) under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="scope-list">
            {scopes.map((s) => (
              <ScopeCard key={s.source.id} s={s} showName={scopes.length > 1} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
