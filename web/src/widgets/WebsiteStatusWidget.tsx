import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { api } from "../api";
import type { Monitor, SiteState } from "../types";
import type { WidgetProps } from "./registry";

const STATE_LABEL: Record<SiteState, string> = {
  up: "online",
  changed: "changed",
  error: "error",
  down: "down",
};

function rank(state: SiteState | null): number {
  switch (state) {
    case "down":
      return 0;
    case "error":
      return 1;
    case "changed":
      return 2;
    case "up":
      return 3;
    default:
      return 4;
  }
}

export default function WebsiteStatusWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "websites"],
    queryFn: () => api.get<Monitor[]>("/api/widgets/websites"),
    refetchInterval: 20_000,
  });

  const sites = useMemo(
    () => [...(data ?? [])].filter((m) => m.enabled).sort((a, b) => rank(a.state) - rank(b.state)),
    [data]
  );
  const up = sites.filter((s) => s.state === "up").length;

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Globe size={12} />
          <span>Website status</span>
        </span>
        {sites.length > 0 && (
          <span className="panel-meta">
            {up}/{sites.length} up
          </span>
        )}
      </header>

      <div className="widget-body">
        {isLoading ? (
          <div className="widget-empty">Sounding the depths…</div>
        ) : sites.length === 0 ? (
          <div className="widget-empty">
            No sites watched yet. Add some under Harbormaster → Sites.
          </div>
        ) : (
          sites.map((s) => (
            <div className={`site-row state-${s.state ?? "pending"}`} key={s.id}>
              <span className={`site-dot state-${s.state ?? "pending"}`} />
              <div className="site-main">
                <div className="site-top">
                  <span className="site-name" title={s.url}>
                    {s.name}
                  </span>
                  <span className={`site-chip state-${s.state ?? "pending"}`}>
                    {s.state ? STATE_LABEL[s.state] : "pending"}
                  </span>
                </div>
                <div className="site-meta">
                  {s.status ? <span>HTTP {s.status}</span> : null}
                  {s.latency != null ? <span>{s.latency} ms</span> : null}
                  {s.uptime != null ? <span>{s.uptime}% 24h</span> : null}
                </div>
                {(s.state === "error" || s.state === "down" || s.state === "changed") &&
                s.message ? (
                  <div className="site-msg">{s.message}</div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
