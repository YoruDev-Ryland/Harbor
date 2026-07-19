import { useQuery } from "@tanstack/react-query";
import { BookOpen, Headphones, PlayCircle } from "lucide-react";
import { api } from "../api";
import type { ProgressResponse } from "../types";
import type { WidgetProps } from "./registry";

export default function ContinueWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "progress"],
    queryFn: () => api.get<ProgressResponse>("/api/widgets/progress"),
    refetchInterval: 60_000,
  });

  const items = data?.items ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <PlayCircle size={12} />
          <span>Continue</span>
        </span>
        {items.length > 0 && <span className="panel-meta">{items.length}</span>}
      </header>

      <div className="widget-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Finding your place…</div>
        ) : items.length === 0 ? (
          <div className="widget-empty">
            {data && data.configured > 0
              ? "Nothing in progress right now."
              : "Nothing in progress. Connect Audiobookshelf or Kavita under Harbormaster → Integrations."}
          </div>
        ) : (
          <div className="cont-list">
            {items.map((p) => (
              <div className="cont-item" key={p.id}>
                <span className="cont-ic">
                  {p.kind === "audiobook" ? <Headphones size={15} /> : <BookOpen size={15} />}
                </span>
                <div className="cont-main">
                  <div className="cont-top">
                    <span className="cont-title" title={p.title}>
                      {p.title}
                    </span>
                    <span className="cont-pct">{Math.round(p.progress * 100)}%</span>
                  </div>
                  {p.subtitle && <div className="cont-sub">{p.subtitle}</div>}
                  <div className="progress">
                    <div
                      className="progress-fill state-playing"
                      style={{ width: `${Math.round(p.progress * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
