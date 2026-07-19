import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, Cpu, Gauge, HardDrive, MemoryStick, Server } from "lucide-react";
import { api } from "../api";
import type { HostMetric, SystemResponse } from "../types";
import { formatSpeed, formatUptime } from "../lib/format";
import type { WidgetProps } from "./registry";

/** ok < 70 ≤ warn < 90 ≤ hot */
function level(pct?: number): "ok" | "warn" | "hot" | "none" {
  if (pct == null) return "none";
  if (pct >= 90) return "hot";
  if (pct >= 70) return "warn";
  return "ok";
}

function Meter({ icon, label, pct }: { icon: React.ReactNode; label: string; pct?: number }) {
  if (pct == null) return null;
  return (
    <div className={`sys-meter lvl-${level(pct)}`}>
      <span className="sys-meter-label">
        {icon}
        {label}
      </span>
      <span className="sys-bar">
        <span className="sys-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="sys-meter-val">{Math.round(pct)}%</span>
    </div>
  );
}

function HostCard({ h }: { h: HostMetric }) {
  const online = h.status === "up";
  return (
    <div className={`sys-card status-${h.status}`}>
      <div className="sys-head">
        <span className={`sys-dot status-${h.status}`} />
        <span className="sys-name" title={h.cpuModel ?? h.hostname ?? h.name}>
          {h.name}
        </span>
        {!online && <span className={`sys-state-chip status-${h.status}`}>{h.status}</span>}
        {online && h.cores ? <span className="sys-cores">{h.cores} cores</span> : null}
      </div>

      {online ? (
        <>
          <Meter icon={<Cpu size={11} />} label="CPU" pct={h.cpuPct} />
          <Meter icon={<MemoryStick size={11} />} label="RAM" pct={h.memPct} />
          <Meter icon={<HardDrive size={11} />} label="Disk" pct={h.diskPct} />
          {h.gpuPct != null && <Meter icon={<Gauge size={11} />} label="GPU" pct={h.gpuPct} />}
          <div className="sys-foot">
            {h.netBps ? (
              <span className="sys-foot-item" title="Network throughput">
                <Activity size={11} /> {formatSpeed(h.netBps)}
              </span>
            ) : null}
            {h.uptimeSec ? (
              <span className="sys-foot-item" title="Uptime">
                <Clock size={11} /> {formatUptime(h.uptimeSec)}
              </span>
            ) : null}
            {h.tempC ? <span className="sys-foot-item">{Math.round(h.tempC)}°C</span> : null}
          </div>
        </>
      ) : (
        <div className="sys-offline">
          {h.status === "paused" ? "Monitoring paused" : "No recent metrics"}
        </div>
      )}
    </div>
  );
}

export default function SystemWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "system"],
    queryFn: () => api.get<SystemResponse>("/api/widgets/system"),
    refetchInterval: 10_000,
  });

  const hosts = data?.hosts ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Server size={12} />
          <span>System</span>
        </span>
        {hosts.length > 0 && (
          <span className="panel-meta">
            {hosts.filter((h) => h.status === "up").length}/{hosts.length} up
          </span>
        )}
      </header>

      <div className="widget-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Taking the engine readings…</div>
        ) : hosts.length === 0 ? (
          <div className="widget-empty">
            No hosts reporting. Add Beszel under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="sys-grid">
            {hosts.map((h) => (
              <HostCard key={h.id} h={h} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
