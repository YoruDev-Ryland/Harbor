import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { api } from "../api";
import type { ContainerInfo, ContainersResponse } from "../types";
import type { WidgetProps } from "./registry";

function healthLabel(c: ContainerInfo): string | null {
  if (c.health === "healthy") return "healthy";
  if (c.health === "unhealthy") return "unhealthy";
  if (c.health === "starting") return "starting";
  return null;
}

export default function ContainersWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "containers"],
    queryFn: () => api.get<ContainersResponse>("/api/widgets/containers"),
    refetchInterval: 15_000,
  });

  const containers = data?.containers ?? [];
  const up = containers.filter((c) => c.up).length;

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Boxes size={12} />
          <span>Containers</span>
        </span>
        {containers.length > 0 && (
          <span className="panel-meta">
            {up}/{containers.length} up
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
          <div className="widget-empty">Reading the manifest…</div>
        ) : containers.length === 0 ? (
          <div className="widget-empty">
            No containers. Add a Portainer access token under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="ctr-list">
            {containers.map((c) => {
              const health = healthLabel(c);
              return (
                <div className={`ctr-item ${c.up ? "up" : "down"}`} key={c.id}>
                  <span
                    className={`ctr-dot ${c.up ? "up" : "down"}${
                      c.health === "unhealthy" ? " unhealthy" : ""
                    }`}
                  />
                  <div className="ctr-main">
                    <div className="ctr-top">
                      <span className="ctr-name" title={c.image ?? c.name}>
                        {c.name}
                      </span>
                      {health && <span className={`ctr-health ${c.health}`}>{health}</span>}
                      {c.env && <span className="ctr-env">{c.env}</span>}
                    </div>
                    <div className="ctr-sub" title={c.status}>
                      {c.status || c.state}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
