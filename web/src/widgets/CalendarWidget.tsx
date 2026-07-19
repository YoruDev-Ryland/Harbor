import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clapperboard, Sparkles, Tv } from "lucide-react";
import { api } from "../api";
import { useSession } from "../App";
import type { CalendarEvent, CalendarResponse, Tab } from "../types";
import type { WidgetProps } from "./registry";
import { dayLabel, timeLabel } from "../lib/format";
import { MOBILE_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import {
  categoryOf,
  parseActions,
  resolveEventUrl,
  useShowUnmonitored,
  type CalendarPrefs,
} from "../lib/calendarPrefs";

const LOCAL_KEY = "harbor.useLocalAddresses";

export default function CalendarWidget({ options }: WidgetProps) {
  const { me } = useSession();
  const [showUnmonitored] = useShowUnmonitored();
  // the action map is the shared, admin-managed default; unmonitored is personal
  const prefs = useMemo<CalendarPrefs>(
    () => ({ showUnmonitored, actions: parseActions(me.calendarActions) }),
    [showUnmonitored, me.calendarActions]
  );
  // the month grid can't fit a phone screen — fall back to the agenda list there
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const view = options.view === "month" && !isMobile ? "month" : "agenda";
  return view === "month" ? <MonthView prefs={prefs} /> : <AgendaView prefs={prefs} />;
}

/** integration id -> browser-facing base url, for deep-linking events into their app */
function useServiceUrls(): Map<number, string> {
  const { data } = useQuery({
    queryKey: ["widget", "calendar", "sources"],
    queryFn: () => api.get<Array<{ id: number; url: string }>>("/api/widgets/calendar/sources"),
    staleTime: 60_000,
  });
  return useMemo(() => new Map((data ?? []).map((i) => [i.id, i.url])), [data]);
}

function usePlexTab(): Tab | undefined {
  const { data } = useQuery({
    queryKey: ["tabs"],
    queryFn: () => api.get<Tab[]>("/api/tabs"),
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      (data ?? []).find((tab) => {
        const haystack = `${tab.name} ${tab.url} ${tab.local_url} ${tab.icon}`.toLowerCase();
        return haystack.includes("plex");
      }),
    [data]
  );
}

function plexWebRoot(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const root = base.includes("/web") ? base.split("#")[0] : `${base}/web/index.html`;
  return root.endsWith("/web") ? `${root}/index.html` : root;
}

function plexTabUrl(tab: Tab): string {
  const useLocal = localStorage.getItem(LOCAL_KEY) === "1";
  return useLocal && tab.local_url ? tab.local_url : tab.url;
}

function plexSearchUrl(tab: Tab, title: string): string {
  return `${plexWebRoot(plexTabUrl(tab))}#!/search?query=${encodeURIComponent(title)}`;
}

function plexUrlOnTab(tab: Tab, targetUrl: string): string {
  const hash = targetUrl.includes("#") ? targetUrl.slice(targetUrl.indexOf("#")) : "";
  return `${plexWebRoot(plexTabUrl(tab))}${hash}`;
}

function useOpenEvent(prefs: CalendarPrefs): (ev: CalendarEvent) => void {
  const navigate = useNavigate();
  const urls = useServiceUrls();
  const plexTab = usePlexTab();
  return async (ev) => {
    const action = prefs.actions[categoryOf(ev)][ev.state];
    if (action === "plex" && plexTab) {
      let url = plexSearchUrl(plexTab, ev.title);
      try {
        const resolved = await api.post<{ url: string }>("/api/widgets/plex/resolve", ev);
        url = plexUrlOnTab(plexTab, resolved.url);
      } catch {
        // No Plex integration/token or no library match yet: fall back to searching this Plex berth.
      }
      if (plexTab.open_mode === "new-tab") {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // frameNonce makes every click a distinct navigation intent, so the
      // shell applies it as an in-app fragment jump (no Plex reload/re-auth)
      navigate(`/tab/${plexTab.id}`, { state: { frameUrl: url, frameNonce: Date.now() } });
      return;
    }
    window.open(
      resolveEventUrl(ev, prefs, urls.get(ev.source.id)),
      "_blank",
      "noopener,noreferrer"
    );
  };
}

interface ViewProps {
  prefs: CalendarPrefs;
}

// ── agenda (list) ─────────────────────────────────────────────────

function AgendaView({ prefs }: ViewProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "calendar", "agenda", prefs.showUnmonitored],
    queryFn: () =>
      api.get<CalendarResponse>(`/api/widgets/calendar?unmonitored=${prefs.showUnmonitored}`),
    refetchInterval: 60_000,
  });
  const openEvent = useOpenEvent(prefs);

  const days = useMemo(() => groupByDay(data?.events ?? []), [data]);
  const todayKey = new Date().toDateString();

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <CalendarDays size={12} />
          <span>Release calendar</span>
        </span>
        <span className="panel-meta">±2 wks</span>
      </header>
      <div className="widget-body">
        <ErrorRows data={data} />
        {isLoading ? (
          <div className="widget-empty">Reading the tide tables…</div>
        ) : days.length === 0 ? (
          <div className="widget-empty">
            No scheduled releases. Add Sonarr or Radarr under Harbormaster → Integrations.
          </div>
        ) : (
          days.map(([dayKey, events]) => (
            <div className="cal-day" key={dayKey}>
              <div className={`cal-day-label${dayKey === todayKey ? " today" : ""}`}>
                {dayLabel(new Date(dayKey))}
              </div>
              {events.map((ev) => (
                <button
                  className={`cal-event state-${ev.state}`}
                  key={ev.id}
                  title={`${ev.source.name} · ${ev.state}`}
                  onClick={() => openEvent(ev)}
                >
                  <span className="cal-text">
                    <span className="cal-title">
                      {ev.title}
                      {ev.episode ? ` · ${ev.episode}` : ""}
                    </span>
                    {ev.subtitle && <span className="cal-sub">{ev.subtitle}</span>}
                  </span>
                  <span className="cal-time">
                    {ev.allDay ? "all day" : timeLabel(new Date(ev.airDateUtc))}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ── month wall ────────────────────────────────────────────────────
// Weeks share the wall height equally; hovering a week compresses the
// others and expands it to a measured height so its full stack of
// releases is readable (scrolling inside the row if still too tall).

const CARD_H = 38; // expanded two-line card incl. gap
const COLLAPSED_H = 30;
const DATE_H = 20;
const CELL_PAD_Y = 14;
// A hovered week never grows past this fraction of the wall. Beyond it the
// other five weeks collapse to unclickable slivers, and the large layout jump
// when the row retracts makes the pointer skip past the row you aimed for.
// Capping keeps neighbours as reliable targets; a taller stack scrolls in-cell.
const MAX_EXPAND_FRACTION = 0.45;

function MonthView({ prefs }: ViewProps) {
  const [monthOffset, setMonthOffset] = useState(0);
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + monthOffset);
  const year = base.getFullYear();
  const month = base.getMonth();

  const gridStart = new Date(year, month, 1);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const { data } = useQuery({
    queryKey: ["widget", "calendar", "month", gridStart.toISOString(), prefs.showUnmonitored],
    queryFn: () =>
      api.get<CalendarResponse>(
        `/api/widgets/calendar?start=${gridStart.toISOString()}&end=${gridEnd.toISOString()}&unmonitored=${prefs.showUnmonitored}`
      ),
    refetchInterval: 60_000,
  });
  const openEvent = useOpenEvent(prefs);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of data?.events ?? []) {
      const key = new Date(ev.airDateUtc).toDateString();
      (map.get(key) ?? map.set(key, []).get(key)!).push(ev);
    }
    return map;
  }, [data]);

  const weeks = useMemo(() => {
    const cells = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
    return Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStart.getTime()]);

  // measure the wall so expanded rows fit exactly inside it
  const wallRef = useRef<HTMLDivElement>(null);
  const [wallH, setWallH] = useState(0);
  useEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWallH(el.clientHeight));
    ro.observe(el);
    setWallH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const rowHeights = weeks.map((week) => {
    const maxEvents = Math.max(1, ...week.map((d) => (byDay.get(d.toDateString()) ?? []).length));
    const wanted = DATE_H + CELL_PAD_Y + maxEvents * CARD_H;
    const evenShare = wallH > 0 ? wallH / weeks.length : wanted;
    // hard floor: never collapse the other weeks below COLLAPSED_H each
    const hardMax = wallH > 0 ? wallH - (weeks.length - 1) * COLLAPSED_H : wanted;
    // soft cap: leave enough room that neighbours stay easy to hover onto
    const expandCap = wallH > 0 ? Math.min(hardMax, wallH * MAX_EXPAND_FRACTION) : wanted;
    return Math.round(Math.min(Math.max(wanted, evenShare), Math.max(expandCap, evenShare)));
  });

  const todayKey = new Date().toDateString();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <CalendarDays size={12} />
          <span>Release calendar</span>
        </span>
      </header>
      <div className="panel-toolbar">
        <div className="cal-nav">
          <button
            className="btn ghost sm"
            onClick={() => setMonthOffset((m) => m - 1)}
            title="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="cal-month-label">
            {base.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </span>
          <button
            className="btn ghost sm"
            onClick={() => setMonthOffset((m) => m + 1)}
            title="Next month"
          >
            <ChevronRight size={15} />
          </button>
          {monthOffset !== 0 && (
            <button className="btn ghost sm" onClick={() => setMonthOffset(0)}>
              Today
            </button>
          )}
        </div>
      </div>
      <ErrorRows data={data} inset />

      <div className="cal-wall-head">
        {weekdays.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="cal-wall" ref={wallRef}>
        {weeks.map((week, wi) => (
          <div
            className="cal-row"
            key={wi}
            style={
              { ["--row-expanded-height" as string]: `${rowHeights[wi]}px` } as React.CSSProperties
            }
          >
            {week.map((d) => {
              const key = d.toDateString();
              const events = byDay.get(key) ?? [];
              const inMonth = d.getMonth() === month;
              return (
                <div
                  className={`cal-cell${inMonth ? "" : " outside"}${key === todayKey ? " today" : ""}`}
                  key={key}
                >
                  <div className="cal-cell-date">{d.getDate()}</div>
                  <div className="cal-cell-events">
                    {events.map((ev) => (
                      <EventCard key={ev.id} ev={ev} onOpen={openEvent} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function EventCard({ ev, onOpen }: { ev: CalendarEvent; onOpen: (ev: CalendarEvent) => void }) {
  const Icon = ev.kind === "movie" ? Clapperboard : ev.isAnime ? Sparkles : Tv;
  const time = ev.allDay
    ? null
    : new Date(ev.airDateUtc).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  const line2 =
    ev.kind === "episode" ? [ev.episode, ev.subtitle].filter(Boolean).join(" · ") : ev.subtitle;
  return (
    <button
      className={`cal-card state-${ev.state}`}
      title={`${ev.title}${ev.episode ? ` ${ev.episode}` : ""} — ${ev.source.name} (${ev.state})`}
      onClick={() => onOpen(ev)}
    >
      <span className="cal-card-line1">
        <Icon size={11} aria-hidden />
        {time && <span className="cal-card-time">{time}</span>}
        <span className="cal-card-title">{ev.title}</span>
      </span>
      {line2 && <span className="cal-card-line2">{line2}</span>}
    </button>
  );
}

// ── shared ────────────────────────────────────────────────────────

function ErrorRows({ data, inset }: { data?: CalendarResponse; inset?: boolean }) {
  if (!data?.errors.length) return null;
  return (
    <div style={inset ? { padding: "8px 8px 0" } : undefined}>
      {data.errors.map((e) => (
        <div className="widget-error" key={e.source.id}>
          {e.source.name}: {e.message}
        </div>
      ))}
    </div>
  );
}

function groupByDay(events: CalendarEvent[]): Array<[string, CalendarEvent[]]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.airDateUtc).toDateString();
    (map.get(key) ?? map.set(key, []).get(key)!).push(ev);
  }
  return [...map.entries()];
}
