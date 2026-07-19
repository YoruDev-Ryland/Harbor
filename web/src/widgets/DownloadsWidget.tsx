import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronDown, ChevronUp, Pause, Play, X } from "lucide-react";
import { api } from "../api";
import { useSession } from "../App";
import { can } from "../lib/perms";
import type { DownloadItem, DownloadsResponse, QueueAction, SourceTag } from "../types";
import { formatBytes, formatEta, formatSpeed } from "../lib/format";
import type { WidgetProps } from "./registry";

const sourceColors: Record<string, string> = {
  sonarr: "#5aa7d6",
  radarr: "#e0b04b",
  sabnzbd: "#f0bc5e",
  qbittorrent: "#4f8fc9",
};

function ItemActions({
  item,
  busy,
  run,
}: {
  item: DownloadItem;
  busy: string | null;
  run: (action: QueueAction) => void;
}) {
  const has = (a: QueueAction) => item.actions?.includes(a);
  const isBusy = (a: QueueAction) => busy === `${item.id}:${a}`;
  const paused = item.state === "paused";
  const btn = (action: QueueAction, title: string, icon: React.ReactNode) => (
    <button className="dl-act" title={title} disabled={isBusy(action)} onClick={() => run(action)}>
      {icon}
    </button>
  );
  return (
    <span className="dl-actions">
      {has("priorityUp") && btn("priorityUp", "Move up", <ChevronUp size={13} />)}
      {has("priorityDown") && btn("priorityDown", "Move down", <ChevronDown size={13} />)}
      {paused
        ? has("resume") && btn("resume", "Resume", <Play size={13} />)
        : has("pause") && btn("pause", "Pause", <Pause size={13} />)}
      {has("remove") && btn("remove", "Remove", <X size={13} />)}
    </span>
  );
}

function SourceBadge({ source }: { source: SourceTag }) {
  return (
    <span className="source-badge">
      <span className="dot" style={{ background: sourceColors[source.type] ?? "var(--accent)" }} />
      {source.name}
    </span>
  );
}

export default function DownloadsWidget(_props: WidgetProps) {
  const { me } = useSession();
  const canControl = can(me.user, "controlDownloads");
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "downloads"],
    queryFn: () => api.get<DownloadsResponse>("/api/widgets/downloads"),
    refetchInterval: 5_000,
  });

  const act = useMutation({
    mutationFn: (v: { id: string; action: QueueAction }) =>
      api.post("/api/widgets/downloads/action", v),
    onMutate: (v) => setBusy(`${v.id}:${v.action}`),
    onSettled: () => {
      setBusy(null);
      queryClient.invalidateQueries({ queryKey: ["widget", "downloads"] });
    },
  });

  const items = (data?.items ?? []).filter((i) => !hidden.has(i.source.id));
  const speed = formatSpeed(data?.totalSpeedBps);

  const toggleSource = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <ArrowDownToLine size={12} />
          <span>Downloads</span>
        </span>
        {speed && <span className="panel-meta">{speed}</span>}
      </header>

      {(data?.sources.length ?? 0) > 1 && (
        <div className="filter-row">
          {data!.sources.map((s) => (
            <button
              key={s.id}
              className={`filter-chip${hidden.has(s.id) ? "" : " on"}`}
              onClick={() => toggleSource(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className="widget-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Checking the manifests…</div>
        ) : items.length === 0 ? (
          <div className="widget-empty">Nothing in the queue — all cargo ashore.</div>
        ) : (
          items.map((item, index) => (
            <div className={`dl-item state-${item.state}`} key={item.id}>
              <div className="dl-title-row">
                <span className="dl-no">{String(index + 1).padStart(2, "0")}</span>
                <span
                  className="dl-title"
                  title={[item.title, item.episode, item.subtitle].filter(Boolean).join(" · ")}
                >
                  {item.title}
                  {item.subtitle ? <span className="dl-sub"> · {item.subtitle}</span> : null}
                </span>
                {item.episode && <span className="dl-ep">{item.episode}</span>}
                <span className={`state-chip state-${item.state}`}>{item.state}</span>
                {canControl && item.actions?.length ? (
                  <ItemActions
                    item={item}
                    busy={busy}
                    run={(action) => act.mutate({ id: item.id, action })}
                  />
                ) : null}
              </div>
              <div className="progress">
                <div
                  className={`progress-fill state-${item.state}`}
                  style={{ width: `${Math.round(item.progress * 100)}%` }}
                />
              </div>
              <div className="dl-meta-row">
                <SourceBadge source={item.source} />
                <span>
                  {formatBytes(item.sizeBytes - item.sizeLeftBytes)} / {formatBytes(item.sizeBytes)}
                </span>
                <div className="grow" />
                {item.speedBps ? <span>{formatSpeed(item.speedBps)}</span> : null}
                {item.etaSeconds ? <span>{formatEta(item.etaSeconds)} left</span> : null}
              </div>
              {item.errorMessage && <div className="widget-error">{item.errorMessage}</div>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
