import { useQuery } from "@tanstack/react-query";
import { Film, Music2, Sparkles, Tv } from "lucide-react";
import { api } from "../api";
import type { RecentItem, RecentResponse } from "../types";
import type { WidgetProps } from "./registry";

function artUrl(it: RecentItem): string | undefined {
  if (!it.artPath) return undefined;
  return `/api/widgets/nowplaying/art?source=${it.source.id}&path=${encodeURIComponent(it.artPath)}`;
}

function KindIcon({ kind }: { kind: RecentItem["kind"] }) {
  if (kind === "movie") return <Film size={16} aria-hidden />;
  if (kind === "album") return <Music2 size={16} aria-hidden />;
  return <Tv size={16} aria-hidden />;
}

export default function RecentlyAddedWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "recent"],
    queryFn: () => api.get<RecentResponse>("/api/widgets/recent"),
    refetchInterval: 120_000,
  });

  const items = data?.items ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <Sparkles size={12} />
          <span>Recently added</span>
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
          <div className="widget-empty">Checking the new arrivals…</div>
        ) : items.length === 0 ? (
          <div className="widget-empty">
            Nothing new yet. Connect Plex or Tautulli under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="poster-wall">
            {items.map((it) => {
              const art = artUrl(it);
              return (
                <figure
                  className="poster"
                  key={it.id}
                  title={`${it.title}${it.subtitle ? ` — ${it.subtitle}` : ""}`}
                >
                  <div className="poster-art">
                    {art ? (
                      <img src={art} alt="" loading="lazy" />
                    ) : (
                      <span className="poster-fallback">
                        <KindIcon kind={it.kind} />
                      </span>
                    )}
                  </div>
                  <figcaption className="poster-cap">
                    <span className="poster-title">{it.title}</span>
                    {it.subtitle && <span className="poster-sub">{it.subtitle}</span>}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
