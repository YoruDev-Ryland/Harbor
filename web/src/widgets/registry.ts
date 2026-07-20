import type { ComponentType } from "react";
import DownloadsWidget from "./DownloadsWidget";
import CalendarWidget from "./CalendarWidget";
import CalendarSettings from "./CalendarSettings";
import StatusWidget from "./StatusWidget";
import OverviewStatsWidget from "./OverviewStatsWidget";
import NowPlayingWidget from "./NowPlayingWidget";
import SystemWidget from "./SystemWidget";
import WebsiteStatusWidget from "./WebsiteStatusWidget";
import IndexersWidget from "./IndexersWidget";
import ContainersWidget from "./ContainersWidget";
import ContinueWidget from "./ContinueWidget";
import RecentlyAddedWidget from "./RecentlyAddedWidget";
import StorageWidget from "./StorageWidget";
import SkyWidget from "./SkyWidget";
import SkyHeatmapWidget from "./SkyHeatmapWidget";
import ScopeWidget from "./ScopeWidget";

/** Props every widget receives so it can adapt to its size on the grid. */
export interface WidgetProps {
  /** current column span (1..4) */
  cols: number;
  /** persisted per-widget options */
  options: Record<string, unknown>;
}

/** An option a widget exposes in the layout editor. */
export interface WidgetOption {
  key: string;
  label: string;
  choices: Array<{ value: string; label: string }>;
  default: string;
}

export interface WidgetMeta {
  id: string;
  name: string;
  component: ComponentType<WidgetProps>;
  defaultCols: number;
  minCols: number;
  /** default height in row units (see lib/layout ROW_UNIT) */
  defaultRows: number;
  /** whether the widget's body scales with height (stat bars don't) */
  resizableHeight?: boolean;
  /** use a compact grid track instead of a full persisted height unit */
  compactHeight?: boolean;
  options?: WidgetOption[];
  /** bespoke settings rendered inside the edit-mode gear (admin/user gated internally) */
  settingsPanel?: ComponentType<{ isAdmin: boolean }>;
}

/** Adding a widget = one component + an entry here. */
export const widgets: WidgetMeta[] = [
  {
    id: "stats",
    name: "Overview stats",
    component: OverviewStatsWidget,
    defaultCols: 4,
    minCols: 2,
    defaultRows: 1,
    resizableHeight: false,
    compactHeight: true,
  },
  {
    id: "calendar",
    name: "Release calendar",
    component: CalendarWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 3,
    resizableHeight: true,
    options: [
      {
        key: "view",
        label: "View",
        choices: [
          { value: "agenda", label: "Agenda (list)" },
          { value: "month", label: "Month grid" },
        ],
        default: "agenda",
      },
    ],
    settingsPanel: CalendarSettings,
  },
  {
    id: "nowplaying",
    name: "Now playing",
    component: NowPlayingWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "downloads",
    name: "Downloads",
    component: DownloadsWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "system",
    name: "System / hosts",
    component: SystemWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "websites",
    name: "Website status",
    component: WebsiteStatusWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "indexers",
    name: "Indexers",
    component: IndexersWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "containers",
    name: "Containers",
    component: ContainersWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "continue",
    name: "Continue (reading/listening)",
    component: ContinueWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "recent",
    name: "Recently added",
    component: RecentlyAddedWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "storage",
    name: "Storage",
    component: StorageWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "sky",
    name: "Sky quality",
    component: SkyWidget,
    defaultCols: 1,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
    options: [
      {
        key: "window",
        label: "History window",
        choices: [
          { value: "6", label: "6 hours" },
          { value: "12", label: "12 hours" },
          { value: "24", label: "24 hours" },
        ],
        default: "12",
      },
    ],
  },
  {
    id: "sky-heatmap",
    name: "Night sky heatmap",
    component: SkyHeatmapWidget,
    defaultCols: 4,
    minCols: 2,
    defaultRows: 2,
    resizableHeight: true,
  },
  {
    id: "scope",
    name: "Telescope (NINA)",
    component: ScopeWidget,
    defaultCols: 2,
    minCols: 1,
    defaultRows: 3,
    resizableHeight: true,
  },
  {
    id: "status",
    name: "Fleet status",
    component: StatusWidget,
    defaultCols: 4,
    minCols: 1,
    defaultRows: 2,
    resizableHeight: true,
  },
];

export const widgetById = new Map(widgets.map((w) => [w.id, w]));
export const widgetIds = new Set(widgets.map((w) => w.id));
