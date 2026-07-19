import { useEffect, useState } from "react";
import type { CalendarEvent } from "../types";

/**
 * Calendar preferences come in two scopes:
 *  - the click-action map (what opening an event does per category/status) is a
 *    shared, admin-managed default, stored server-side (setting `calendar_actions`);
 *  - "show unmonitored" is a personal view preference kept in localStorage.
 */

export type CalCategory = "movie" | "tv" | "anime";
export type ClickAction = "app" | "imdb" | "tvdb" | "trakt" | "plex" | "mal";

export const clickActions: Array<{ value: ClickAction; label: string }> = [
  { value: "app", label: "App" },
  { value: "imdb", label: "IMDb" },
  { value: "tvdb", label: "TVDB" },
  { value: "trakt", label: "Trakt" },
  { value: "plex", label: "Plex" },
  { value: "mal", label: "MAL" },
];

export const calStatuses = ["downloaded", "downloading", "missing", "unaired"] as const;
export type CalStatus = (typeof calStatuses)[number];

export const calCategories: Array<{ id: CalCategory; label: string }> = [
  { id: "movie", label: "Movies" },
  { id: "tv", label: "TV" },
  { id: "anime", label: "Anime" },
];

export type ActionMap = Record<CalCategory, Record<CalStatus, ClickAction>>;

export interface CalendarPrefs {
  showUnmonitored: boolean;
  actions: ActionMap;
}

function defaultActions(action: ClickAction): Record<CalStatus, ClickAction> {
  return { downloaded: action, downloading: action, missing: action, unaired: action };
}

export const defaultActionMap: ActionMap = {
  movie: defaultActions("app"),
  tv: defaultActions("app"),
  anime: defaultActions("app"),
};

/** Pull a legacy per-browser action map (pre-server-storage) if one exists, so
 *  an admin's older choices can be migrated into the shared setting once. */
export function readLegacyActions(): ActionMap | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.actions) return null;
    return parseActions(JSON.stringify(parsed.actions));
  } catch {
    return null;
  }
}

/** Merge a stored (possibly partial) action map onto the defaults. */
export function parseActions(raw: string | null | undefined): ActionMap {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      movie: { ...defaultActionMap.movie, ...parsed?.movie },
      tv: { ...defaultActionMap.tv, ...parsed?.tv },
      anime: { ...defaultActionMap.anime, ...parsed?.anime },
    };
  } catch {
    return defaultActionMap;
  }
}

// ── personal "show unmonitored" (localStorage, live across widget instances) ──

const LOCAL_KEY = "harbor.calendar.local";
const LEGACY_KEY = "harbor.calendar.prefs";
const LOCAL_EVENT = "harbor:calprefs";

export function loadShowUnmonitored(): boolean {
  for (const key of [LOCAL_KEY, LEGACY_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw).showUnmonitored ?? true;
    } catch {
      /* try the next key */
    }
  }
  return true;
}

export function setShowUnmonitored(value: boolean): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ showUnmonitored: value }));
  window.dispatchEvent(new Event(LOCAL_EVENT));
}

/** Reactive personal toggle — stays in sync whether it's changed here or in the
 *  settings menu of another widget instance. */
export function useShowUnmonitored(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(loadShowUnmonitored);
  useEffect(() => {
    const sync = () => setValue(loadShowUnmonitored());
    window.addEventListener(LOCAL_EVENT, sync);
    return () => window.removeEventListener(LOCAL_EVENT, sync);
  }, []);
  return [
    value,
    (next) => {
      setShowUnmonitored(next);
      setValue(next);
    },
  ];
}

export function categoryOf(ev: CalendarEvent): CalCategory {
  if (ev.kind === "movie") return "movie";
  if (ev.isAnime) return "anime";
  return "tv";
}

/**
 * Resolve the URL an event click should open. Falls back gracefully when the
 * chosen action lacks the data it needs (e.g. no IMDb id yet for a new show).
 */
export function eventUrl(
  ev: CalendarEvent,
  action: ClickAction,
  serviceUrl: string | undefined
): string {
  const ids = ev.externalIds ?? {};
  const searchTitle = encodeURIComponent(ev.title);

  switch (action) {
    case "app":
      if (serviceUrl && ids.slug) {
        const path = ev.kind === "movie" ? `/movie/${ids.slug}` : `/series/${ids.slug}`;
        return `${serviceUrl.replace(/\/+$/, "")}${path}`;
      }
      break;
    case "imdb":
      if (ids.imdb) return `https://www.imdb.com/title/${ids.imdb}/`;
      return `https://www.imdb.com/find/?q=${searchTitle}`;
    case "tvdb":
      if (ids.tvdb) return `https://www.thetvdb.com/dereferrer/series/${ids.tvdb}`;
      return `https://www.thetvdb.com/search?query=${searchTitle}`;
    case "trakt":
      if (ids.imdb) return `https://trakt.tv/search/imdb?query=${ids.imdb}`;
      return `https://trakt.tv/search?query=${searchTitle}`;
    case "plex":
      return `https://app.plex.tv/desktop/#!/search?pivot=top&query=${searchTitle}`;
    case "mal":
      return `https://myanimelist.net/anime.php?q=${searchTitle}`;
  }

  // fallback chain: app link failed → IMDb id → IMDb search
  if (ids.imdb) return `https://www.imdb.com/title/${ids.imdb}/`;
  return `https://www.imdb.com/find/?q=${searchTitle}`;
}

export function resolveEventUrl(
  ev: CalendarEvent,
  prefs: CalendarPrefs,
  serviceUrl: string | undefined
): string {
  const action = prefs.actions[categoryOf(ev)][ev.state];
  return eventUrl(ev, action, serviceUrl);
}
