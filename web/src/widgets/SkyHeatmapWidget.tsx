import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Grid2x2 } from "lucide-react";
import { api } from "../api";
import type { SkyHeatmapBucket, SkyHeatmapResponse } from "../types";
import type { WidgetProps } from "./registry";

// The night window shown on the y-axis: 16:00 → 09:00 next morning (17 h), so a
// whole night sits in one column and midday (the boring, always-bright part) is
// trimmed — matching the classic SQM "night sky" heatmap framing.
const WIN_START_HOUR = 16;
const WIN_HOURS = 17;
const ROWS = WIN_HOURS * 2; // 30-minute rows
const MSAS_MIN = 16;
const MSAS_MAX = 22;

/** magma colormap — the de-facto standard for sky-brightness maps: perceptually
 *  uniform and monotonic in lightness (so it survives colour-blind & greyscale). */
const MAGMA: Array<[number, number, number]> = [
  [0, 0, 4],
  [28, 16, 68],
  [79, 18, 123],
  [129, 37, 129],
  [181, 54, 122],
  [229, 80, 100],
  [251, 135, 97],
  [254, 194, 135],
  [252, 253, 191],
];
function magma(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (MAGMA.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = MAGMA[i];
  const b = MAGMA[Math.min(MAGMA.length - 1, i + 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}
const norm = (v: number) => (v - MSAS_MIN) / (MSAS_MAX - MSAS_MIN);

function daysInYear(y: number): number {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}
/** day-of-year (0-based) from local Y/M/D, via UTC of the components (DST-safe). */
function dayOfYear(year: number, d: Date): number {
  return Math.floor(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(year, 0, 1)) / 86_400_000
  );
}

interface Grid {
  days: number;
  val: Float32Array; // day*ROWS + row, NaN = no data
}
function buildGrid(buckets: SkyHeatmapBucket[], year: number): Grid {
  const days = daysInYear(year);
  const sum = new Float64Array(days * ROWS);
  const cnt = new Float64Array(days * ROWS);
  for (const b of buckets) {
    const d = new Date(b.t * 1000);
    const hf = d.getHours() + d.getMinutes() / 60;
    let obs = d;
    let rowHour: number;
    if (hf >= WIN_START_HOUR) rowHour = hf - WIN_START_HOUR;
    else if (hf < WIN_START_HOUR + WIN_HOURS - 24) {
      rowHour = hf + (24 - WIN_START_HOUR);
      obs = new Date(d.getTime() - 86_400_000); // pre-dawn belongs to the prior evening
    } else continue; // outside the night window (midday)
    const dayIdx = dayOfYear(year, obs);
    if (dayIdx < 0 || dayIdx >= days) continue;
    const row = Math.min(ROWS - 1, Math.max(0, Math.floor(rowHour * 2)));
    const idx = dayIdx * ROWS + row;
    sum[idx] += b.v * b.n;
    cnt[idx] += b.n;
  }
  const val = new Float32Array(days * ROWS).fill(NaN);
  for (let i = 0; i < val.length; i++) if (cnt[i] > 0) val[i] = sum[i] / cnt[i];
  return { days, val };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PAD = { l: 44, r: 56, t: 8, b: 18 };

function Heatmap({ grid, year }: { grid: Grid; year: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef({ cellW: 0, cellH: 0 });
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    date: string;
    time: string;
    v: number;
  } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const draw = () => {
      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      if (cssW < 20 || cssH < 20) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const cs = getComputedStyle(canvas);
      const ink = cs.getPropertyValue("--text-faint").trim() || "#7a8b99";
      const font =
        "10px " + (cs.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace");

      const plotW = cssW - PAD.l - PAD.r;
      const plotH = cssH - PAD.t - PAD.b;
      if (plotW < 10 || plotH < 10) return;
      const cellW = plotW / grid.days;
      const cellH = plotH / ROWS;
      layoutRef.current = { cellW, cellH };

      // cells
      for (let day = 0; day < grid.days; day++) {
        for (let row = 0; row < ROWS; row++) {
          const v = grid.val[day * ROWS + row];
          if (Number.isNaN(v)) continue;
          ctx.fillStyle = magma(norm(v));
          ctx.fillRect(PAD.l + day * cellW, PAD.t + row * cellH, cellW + 0.7, cellH + 0.7);
        }
      }

      // y-axis time labels
      ctx.fillStyle = ink;
      ctx.font = font;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const h of [18, 21, 0, 3, 6]) {
        const rowHour = h >= WIN_START_HOUR ? h - WIN_START_HOUR : h + (24 - WIN_START_HOUR);
        if (rowHour < 0 || rowHour > WIN_HOURS) continue;
        const y = PAD.t + rowHour * 2 * cellH;
        ctx.fillText(`${String(h).padStart(2, "0")}:00`, PAD.l - 6, y);
      }

      // x-axis month labels
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      for (let m = 0; m < 12; m++) {
        const doy = dayOfYear(year, new Date(year, m, 1));
        ctx.fillText(MONTHS[m], PAD.l + doy * cellW + 1, cssH - 5);
      }

      // colorbar
      const barX = cssW - PAD.r + 14;
      const barW = 12;
      for (let i = 0; i < plotH; i++) {
        ctx.fillStyle = magma(1 - i / plotH);
        ctx.fillRect(barX, PAD.t + i, barW, 1.2);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let v = MSAS_MIN; v <= MSAS_MAX; v += 2) {
        const y = PAD.t + (1 - norm(v)) * plotH;
        ctx.fillText(String(v), barX + barW + 4, y);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    // redraw when the theme (light/dark) changes so canvas ink stays legible
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", draw);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", draw);
    };
  }, [grid, year]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const { cellW, cellH } = layoutRef.current;
    if (!canvas || !cellW || !cellH) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const day = Math.floor((x - PAD.l) / cellW);
    const row = Math.floor((y - PAD.t) / cellH);
    if (day < 0 || day >= grid.days || row < 0 || row >= ROWS) return setTip(null);
    const v = grid.val[day * ROWS + row];
    if (Number.isNaN(v)) return setTip(null);
    const date = new Date(Date.UTC(year, 0, 1) + day * 86_400_000);
    const clockMin = (WIN_START_HOUR * 60 + row * 30) % (24 * 60);
    const time = `${String(Math.floor(clockMin / 60)).padStart(2, "0")}:${String(clockMin % 60).padStart(2, "0")}`;
    setTip({
      x,
      y,
      date: date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
      time,
      v,
    });
  };

  return (
    <div className="heat-plot" ref={wrapRef}>
      <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      {tip && (
        <div
          className="heat-tip"
          style={{
            left: tip.x,
            top: tip.y,
            transform: `translate(${tip.x > (wrapRef.current?.clientWidth ?? 0) - 120 ? "-100%" : "0"}, -115%)`,
          }}
        >
          <strong>{tip.v.toFixed(2)}</strong> MSAS
          <span>
            {tip.date} · {tip.time}
          </span>
        </div>
      )}
    </div>
  );
}

export default function SkyHeatmapWidget(_props: WidgetProps) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "sky-heatmap", year],
    queryFn: () => api.get<SkyHeatmapResponse>(`/api/widgets/sky/heatmap?year=${year}`),
    refetchInterval: 300_000,
  });

  const grid = useMemo(() => buildGrid(data?.buckets ?? [], year), [data?.buckets, year]);
  const noIntegration = !isLoading && (data?.configured ?? 0) === 0;

  const minYear = data?.minYear ?? year;
  const maxYear = data?.maxYear ?? thisYear;
  const step = (delta: number) => setYear((y) => Math.max(minYear, Math.min(maxYear, y + delta)));

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Grid2x2 size={12} />
          <span>Night sky heatmap</span>
        </span>
        <span className="heat-yearsel">
          <button
            className="btn ghost sm"
            onClick={() => step(-1)}
            disabled={year <= minYear}
            title="Previous year"
            aria-label="Previous year"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="heat-year">{year}</span>
          <button
            className="btn ghost sm"
            onClick={() => step(1)}
            disabled={year >= maxYear}
            title="Next year"
            aria-label="Next year"
          >
            <ChevronRight size={14} />
          </button>
        </span>
      </header>

      <div className="heat-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Charting the year…</div>
        ) : noIntegration ? (
          <div className="widget-empty">
            No sky readings. Add an SQM meter under Harbormaster → Integrations.
          </div>
        ) : (
          <>
            <Heatmap grid={grid} year={year} />
            <p className="heat-note">
              Each cell is average MSAS over 30 minutes. Green = darker sky (higher MSAS); warm/dark
              cells are brighter sky from moonlight, twilight or cloud. Blank areas have no readings
              yet.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
