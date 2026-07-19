import { useQuery } from "@tanstack/react-query";
import { Rss } from "lucide-react";
import { api } from "../api";
import type { IndexersResponse } from "../types";
import type { WidgetProps } from "./registry";

export default function IndexersWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "indexers"],
    queryFn: () => api.get<IndexersResponse>("/api/widgets/indexers"),
    refetchInterval: 30_000,
  });

  const indexers = data?.indexers ?? [];
  const enabled = indexers.filter((i) => i.enabled);
  const up = enabled.filter((i) => i.up).length;

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Rss size={12} />
          <span>Indexers</span>
        </span>
        {enabled.length > 0 && (
          <span className="panel-meta">
            {up}/{enabled.length} up
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
          <div className="widget-empty">Polling the indexers…</div>
        ) : indexers.length === 0 ? (
          <div className="widget-empty">
            No indexers. Add Prowlarr under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="status-grid">
            {indexers.map((ix) => {
              const cls = !ix.enabled ? "muted" : ix.up ? "up" : "down";
              return (
                <div className={`status-item ${cls}`} key={ix.id} title={ix.message ?? ix.name}>
                  <span className="name">{ix.name}</span>
                  <span className="latency">{!ix.enabled ? "off" : ix.up ? "up" : "down"}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
