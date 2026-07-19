import { useQuery } from "@tanstack/react-query";
import { Film, MonitorPlay, Music2, Pause, Play, Tv, User } from "lucide-react";
import { api } from "../api";
import type { NowPlayingResponse, NowPlayingSession } from "../types";
import type { WidgetProps } from "./registry";

function artUrl(s: NowPlayingSession): string | undefined {
  if (!s.artPath) return undefined;
  return `/api/widgets/nowplaying/art?source=${s.source.id}&path=${encodeURIComponent(s.artPath)}`;
}

function KindIcon({ kind }: { kind: NowPlayingSession["kind"] }) {
  if (kind === "movie") return <Film size={14} aria-hidden />;
  if (kind === "track") return <Music2 size={14} aria-hidden />;
  return <Tv size={14} aria-hidden />;
}

/** ms → m:ss (or h:mm:ss for long items) */
function clock(ms?: number): string {
  if (!ms || ms <= 0) return "0:00";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export default function NowPlayingWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "nowplaying"],
    queryFn: () => api.get<NowPlayingResponse>("/api/widgets/nowplaying"),
    refetchInterval: 5_000,
  });

  const sessions = data?.sessions ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <MonitorPlay size={12} />
          <span>Now playing</span>
        </span>
        {sessions.length > 0 && (
          <span className="panel-meta">
            {sessions.length} stream{sessions.length === 1 ? "" : "s"}
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
          <div className="widget-empty">Scanning the airwaves…</div>
        ) : sessions.length === 0 ? (
          <div className="widget-empty">Nothing streaming right now.</div>
        ) : (
          sessions.map((s) => <SessionRow key={s.id} s={s} />)
        )}
      </div>
    </section>
  );
}

function SessionRow({ s }: { s: NowPlayingSession }) {
  const art = artUrl(s);
  const pct = Math.round(s.progress * 100);
  const heading = s.grandparentTitle ?? s.title;
  const line2 = s.grandparentTitle ? s.title : s.subtitle;
  const line3 = s.grandparentTitle ? s.subtitle : undefined;

  return (
    <div className="np-item">
      <div className="np-art">
        {art ? (
          <img src={art} alt="" loading="lazy" />
        ) : (
          <span className="np-art-fallback">
            <KindIcon kind={s.kind} />
          </span>
        )}
        <span className={`np-state-badge state-${s.state}`} title={s.state}>
          {s.state === "paused" ? <Pause size={11} /> : <Play size={11} />}
        </span>
      </div>

      <div className="np-body">
        <div className="np-heading" title={heading}>
          <KindIcon kind={s.kind} />
          <span className="np-title">{heading}</span>
        </div>
        {line2 && (
          <div className="np-sub" title={line2}>
            {line2}
          </div>
        )}
        {line3 && <div className="np-sub faint">{line3}</div>}

        <div className="progress np-progress">
          <div className={`progress-fill state-${s.state}`} style={{ width: `${pct}%` }} />
        </div>

        <div className="np-meta-row">
          {s.user && (
            <span className="np-chip">
              <User size={11} /> {s.user}
            </span>
          )}
          {s.player && <span className="np-player">{s.player}</span>}
          <div className="grow" />
          <span className="np-time">
            {clock(s.viewOffsetMs)} / {clock(s.durationMs)}
          </span>
          {s.decision && (
            <span className={`np-decision ${s.decision.replace(/\s+/g, "-")}`}>{s.decision}</span>
          )}
        </div>
      </div>
    </div>
  );
}
