import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoonStar, Thermometer } from "lucide-react";
import { api } from "../api";
import { timeLabel } from "../lib/format";
import type { SkyReading, SkyResponse } from "../types";
import type { WidgetProps } from "./registry";

/**
 * Sky brightness in mag/arcsec² → a plain-language darkness band. Higher mpsas
 * is darker. 0 (with a cap on / in daylight) is its own "daylight" case.
 */
function quality(mpsas: number): { label: string; cls: string } {
  if (mpsas <= 0) return { label: "Daylight", cls: "day" };
  if (mpsas >= 21.7) return { label: "Pristine", cls: "pristine" };
  if (mpsas >= 21.3) return { label: "Truly dark", cls: "dark" };
  if (mpsas >= 20.4) return { label: "Rural", cls: "rural" };
  if (mpsas >= 19.1) return { label: "Suburban", cls: "suburban" };
  if (mpsas >= 18.0) return { label: "Bright suburb", cls: "bright" };
  return { label: "City glow", cls: "city" };
}

/** "just now" / "3 min ago" / "2 h ago" from an epoch-ms timestamp. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/**
 * Theme-coloured sparkline of recent mpsas. The SVG uses a fixed viewBox with
 * `preserveAspectRatio="none"`, so it stretches to whatever box CSS gives it —
 * the graph scales in both axes when the widget is resized. Hovering reads off
 * the nearest sample (crosshair + dot + a value/time tooltip).
 */
function Spark({ history }: { history: NonNullable<SkyReading["history"]> }) {
  const [idx, setIdx] = useState<number | null>(null);
  const n = history.length;
  const w = 240;
  const h = 44;
  const pad = 2;
  const vals = history.map((p) => p.mpsas);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const line = history
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.mpsas).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;

  // viewBox → percentage of the rendered box (matches the stretched SVG exactly)
  const pctX = (i: number) => (x(i) / w) * 100;
  const pctY = (v: number) => (y(v) / h) * 100;
  const hovered = idx != null ? history[idx] : null;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setIdx(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))));
  };

  return (
    <div className="sky-spark-wrap" onPointerMove={onMove} onPointerLeave={() => setIdx(null)}>
      <svg
        className="sky-spark"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="sky-spark-area" d={area} />
        <path className="sky-spark-line" d={line} />
      </svg>
      {hovered && idx != null && (
        <>
          <div className="sky-cross" style={{ left: `${pctX(idx)}%` }} />
          <div
            className="sky-dot"
            style={{ left: `${pctX(idx)}%`, top: `${pctY(hovered.mpsas)}%` }}
          />
          <div
            className="sky-tip"
            style={{
              left: `${pctX(idx)}%`,
              transform: `translateX(${pctX(idx) < 18 ? "0" : pctX(idx) > 82 ? "-100%" : "-50%"})`,
            }}
          >
            <strong>{hovered.mpsas.toFixed(2)}</strong>
            <span>{timeLabel(new Date(hovered.at))}</span>
          </div>
        </>
      )}
    </div>
  );
}

function ReadingCard({ r, solo }: { r: SkyReading; solo?: boolean }) {
  const q = quality(r.mpsas);
  const daytime = r.mpsas <= 0;
  return (
    <div className={`sky-card q-${q.cls}${solo ? " sky-solo" : ""}`}>
      <div className="sky-head">
        <span className="sky-name" title={r.source.name}>
          {r.source.name}
        </span>
        <span className={`sky-chip q-${q.cls}`}>{q.label}</span>
      </div>

      <div className="sky-readout">
        <span className="sky-value">{daytime ? "—" : r.mpsas.toFixed(2)}</span>
        <span className="sky-unit">mag/arcsec²</span>
      </div>

      {r.history && r.history.length > 1 && <Spark history={r.history} />}

      <div className="sky-foot">
        <span className="sky-foot-item" title="Reading age">
          {ago(r.at)}
        </span>
        {r.temperatureC != null && (
          <span className="sky-foot-item" title="Sensor (internal) temperature">
            <Thermometer size={11} /> {Math.round(r.temperatureC)}°C
          </span>
        )}
        {r.darkestMpsas != null && (
          <span className="sky-foot-item" title={`Darkest in the last ${r.windowHours ?? 12} h`}>
            ↓ {r.darkestMpsas.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

export default function SkyWidget({ options }: WidgetProps) {
  const hours = Number(options.window) || 12;
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "sky", hours],
    queryFn: () => api.get<SkyResponse>(`/api/widgets/sky?hours=${hours}`),
    refetchInterval: 60_000,
  });

  const readings = data?.readings ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <MoonStar size={12} />
          <span>Sky quality</span>
        </span>
        {readings.length > 1 && <span className="panel-meta">{readings.length}</span>}
      </header>

      {data?.errors.map((e) => (
        <div className="widget-error" key={e.source.id}>
          {e.source.name}: {e.message}
        </div>
      ))}

      {isLoading ? (
        <div className="widget-body">
          <div className="widget-empty">Reading the sky…</div>
        </div>
      ) : readings.length === 0 ? (
        <div className="widget-body">
          <div className="widget-empty">
            No sky readings. Add an SQM meter under Harbormaster → Integrations.
          </div>
        </div>
      ) : readings.length === 1 ? (
        // one meter (the common case) fills the widget so it resizes with it
        <div className="sky-wall">
          <ReadingCard r={readings[0]} solo />
        </div>
      ) : (
        <div className="widget-body">
          <div className="sky-grid">
            {readings.map((r) => (
              <ReadingCard key={r.source.id} r={r} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
