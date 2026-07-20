import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Film, Music2, Sparkles, Tv } from "lucide-react";
import { api } from "../api";
import type { RecentItem, RecentResponse, Tab } from "../types";
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

const LOCAL_KEY = "harbor.useLocalAddresses";

function plexWebRoot(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const root = base.includes("/web") ? base.split("#")[0] : `${base}/web/index.html`;
  return root.endsWith("/web") ? `${root}/index.html` : root;
}

function plexTabUrl(tab: Tab): string {
  return localStorage.getItem(LOCAL_KEY) === "1" && tab.local_url ? tab.local_url : tab.url;
}

function plexUrlOnTab(tab: Tab, targetUrl: string): string {
  const hash = targetUrl.includes("#") ? targetUrl.slice(targetUrl.indexOf("#")) : "";
  return `${plexWebRoot(plexTabUrl(tab))}${hash}`;
}

function plexSearchUrl(tab: Tab, title: string): string {
  return `${plexWebRoot(plexTabUrl(tab))}#!/search?query=${encodeURIComponent(title)}`;
}

export default function RecentlyAddedWidget(_props: WidgetProps) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "recent"],
    queryFn: () => api.get<RecentResponse>("/api/widgets/recent"),
    refetchInterval: 120_000,
  });
  const { data: tabs } = useQuery({
    queryKey: ["tabs"],
    queryFn: () => api.get<Tab[]>("/api/tabs"),
    staleTime: 60_000,
  });

  const plexTabs = useMemo(
    () =>
      (tabs ?? []).filter((tab) =>
        `${tab.name} ${tab.url} ${tab.local_url} ${tab.icon}`.toLowerCase().includes("plex")
      ),
    [tabs]
  );

  const openInPlex = async (item: RecentItem) => {
    if (!item.ratingKey) return;
    const tab =
      (item.source.type === "plex"
        ? (tabs ?? []).find((candidate) => candidate.integration_id === item.source.id)
        : undefined) ?? plexTabs[0];
    if (!tab) return;
    let url = plexSearchUrl(tab, item.title);
    try {
      const resolved = await api.post<{ url: string }>("/api/widgets/plex/recent/resolve", {
        source: { id: item.source.id, type: item.source.type },
        ratingKey: item.ratingKey,
      });
      url = plexUrlOnTab(tab, resolved.url);
    } catch {
      // No matching Plex integration/server: fall back to searching the selected Plex berth.
    }
    if (tab.open_mode === "new-tab") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    navigate(`/tab/${tab.id}`, { state: { frameUrl: url, frameNonce: Date.now() } });
  };

  const hasPlexDestination = (item: RecentItem) =>
    item.source.type === "plex"
      ? (tabs ?? []).some((tab) => tab.integration_id === item.source.id) || plexTabs.length > 0
      : plexTabs.length > 0;

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
                <button
                  type="button"
                  className="poster"
                  key={it.id}
                  title={`${it.title}${it.subtitle ? ` — ${it.subtitle}` : ""}`}
                  onClick={() => openInPlex(it)}
                  disabled={!it.ratingKey || !hasPlexDestination(it)}
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
                  <span className="poster-cap">
                    <span className="poster-title">{it.title}</span>
                    {it.subtitle && <span className="poster-sub">{it.subtitle}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
