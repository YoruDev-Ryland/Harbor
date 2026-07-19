import { useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { api } from "../api";
import type { StatusResponse } from "../types";
import type { WidgetProps } from "./registry";

export default function StatusWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "status"],
    queryFn: () => api.get<StatusResponse>("/api/widgets/status"),
    refetchInterval: 30_000,
  });

  const services = data?.services ?? [];
  const up = services.filter((s) => s.ok).length;

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Radar size={12} />
          <span>Fleet status</span>
        </span>
        {services.length > 0 && (
          <span className="panel-meta">
            {up}/{services.length} up
          </span>
        )}
      </header>
      <div className="widget-body">
        {isLoading ? (
          <div className="widget-empty">Sweeping the horizon…</div>
        ) : services.length === 0 ? (
          <div className="widget-empty">
            Nothing to watch yet. Berths with ping enabled and integrations report here.
          </div>
        ) : (
          <div className="status-grid">
            {services.map((s) => (
              <div
                className={`status-item ${s.ok ? "up" : "down"}`}
                key={`${s.kind}-${s.id}`}
                title={s.message ?? (s.version ? `v${s.version}` : undefined)}
              >
                <span className="name">{s.name}</span>
                <span className="latency">{s.ok ? `${s.latencyMs}ms` : "down"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
