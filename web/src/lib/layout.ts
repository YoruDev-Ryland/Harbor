import { widgetById, widgetIds } from "../widgets/registry";

/** One placed widget on the overview grid. */
export interface LayoutItem {
  /** widget type id from the registry */
  id: string;
  /** column span on a 4-column grid (1 = quarter, 4 = full width) */
  cols: number;
  /** height in row units (1 unit ≈ ROW_UNIT px of scrollable body) */
  rows: number;
  /** per-widget settings (e.g. calendar view mode) */
  options?: Record<string, unknown>;
  /** group ids allowed to see this widget; empty/undefined = everyone */
  allowed_groups?: number[];
}

export const GRID_COLUMNS = 4;
export const MIN_ROWS = 1;
export const MAX_ROWS = 6;

/** default height (row units) for a widget that has none stored yet */
export function defaultRowsFor(id: string): number {
  return widgetById.get(id)?.defaultRows ?? 2;
}

export const defaultLayout: LayoutItem[] = [
  { id: "stats", cols: 4, rows: defaultRowsFor("stats") },
  { id: "calendar", cols: 2, rows: defaultRowsFor("calendar") },
  { id: "nowplaying", cols: 2, rows: defaultRowsFor("nowplaying") },
  { id: "downloads", cols: 2, rows: defaultRowsFor("downloads") },
  { id: "status", cols: 4, rows: defaultRowsFor("status") },
];

/** Parse the stored layout string, dropping anything the registry no longer knows. */
export function parseLayout(raw: string): LayoutItem[] {
  if (!raw) return defaultLayout;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultLayout;
    const cleaned = parsed
      .filter((item) => item && widgetIds.has(item.id))
      .map((item) => ({
        id: String(item.id),
        cols: clampCols(Number(item.cols) || 2),
        // older layouts predate per-widget height — fall back to the widget default
        rows: clampRows(Number(item.rows) || defaultRowsFor(String(item.id))),
        options: item.options && typeof item.options === "object" ? item.options : undefined,
        allowed_groups: Array.isArray(item.allowed_groups)
          ? item.allowed_groups.map(Number).filter(Number.isFinite)
          : undefined,
      }));
    return cleaned.length > 0 ? cleaned : defaultLayout;
  } catch {
    return defaultLayout;
  }
}

export function clampCols(cols: number): number {
  return Math.max(1, Math.min(GRID_COLUMNS, Math.round(cols)));
}

export function clampRows(rows: number): number {
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(rows)));
}
