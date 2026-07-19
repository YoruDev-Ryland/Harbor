import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { api } from "../api";
import type { DownloadsResponse, StatusResponse } from "../types";
import { formatSpeed } from "../lib/format";
import type { WidgetProps } from "./registry";

export default function OverviewStatsWidget(_props: WidgetProps) {
  const [now, setNow] = useState(() => new Date());
  const { data: downloads } = useQuery({
    queryKey: ["widget", "downloads"],
    queryFn: () => api.get<DownloadsResponse>("/api/widgets/downloads"),
    refetchInterval: 5_000,
  });
  const { data: fleet } = useQuery({
    queryKey: ["widget", "status"],
    queryFn: () => api.get<StatusResponse>("/api/widgets/status"),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const active = downloads?.items.filter((i) => i.state === "downloading").length ?? 0;
  const speed = formatSpeed(downloads?.totalSpeedBps);
  const fleetUp = fleet?.services.filter((s) => s.ok).length ?? 0;
  const fleetTotal = fleet?.services.length ?? 0;

  return (
    <section className="widget stats-widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Gauge size={12} />
          <span>Overview stats</span>
        </span>
      </header>
      <dl className="stats-strip">
        <div className="stat">
          <dt>Clock</dt>
          <dd>
            <time dateTime={now.toISOString()}>
              {now.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </dd>
        </div>
        <div className="stat">
          <dt>Date</dt>
          <dd>
            {now.toLocaleDateString(undefined, {
              weekday: "short",
              day: "2-digit",
              month: "short",
            })}
          </dd>
        </div>
        <div className="stat">
          <dt>Underway</dt>
          <dd>
            {active}
            {speed && <span className="stat-unit">{speed}</span>}
          </dd>
        </div>
        <div className="stat">
          <dt>Fleet</dt>
          <dd>
            {fleetTotal > 0 ? (
              <>
                {fleetUp}
                <span className="stat-slash">/</span>
                {fleetTotal}
                <span className="stat-unit">responding</span>
              </>
            ) : (
              "-"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
