import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Check, GripVertical, Minus, MoveVertical, Plus, RotateCcw, X } from "lucide-react";
import { api } from "../api";
import { useSession } from "../App";
import { can } from "../lib/perms";
import { widgetById, widgets } from "../widgets/registry";
import WidgetSettingsMenu from "../components/WidgetSettingsMenu";
import { canSeeWidget } from "../lib/moduleAccess";
import {
  clampCols,
  clampRows,
  defaultRowsFor,
  GRID_COLUMNS,
  MAX_ROWS,
  MIN_ROWS,
  parseLayout,
  type LayoutItem,
} from "../lib/layout";

export default function Dashboard() {
  const { me, refresh } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // editing the shared default (and setting per-module visibility) is a permission;
  // personalising your own overview is open to anyone who can see it
  const canEditDefault = can(me.user, "editLayout");

  // group-visibility rules always come from the shared default, so an admin's
  // later restriction still applies to someone who's already personalised
  const sharedDefault = useMemo(() => parseLayout(me.defaultLayout), [me.defaultLayout]);
  const widgetAllowed = useMemo(() => (id: string) => canSeeWidget(me, id), [me]);

  const saved = useMemo(() => {
    const eff = parseLayout(me.layout);
    return canEditDefault ? eff : eff.filter((i) => widgetAllowed(i.id));
  }, [me.layout, canEditDefault, widgetAllowed]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LayoutItem[]>(saved);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!(location.state as { editLayout?: boolean } | null)?.editLayout) return;
    setEditing(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  // keep the draft in sync when the saved layout changes and we're not editing
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);

  const layout = editing ? draft : saved;

  const finishEdit = async () => {
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    refresh();
    setEditing(false);
  };
  // personal layout — anyone; only touches this user's own view
  const saveMine = useMutation({
    mutationFn: () => api.patch("/api/auth/prefs", { layout: JSON.stringify(draft) }),
    onSuccess: finishEdit,
  });
  // shared default — editors only
  const saveDefault = useMutation({
    mutationFn: () => api.patch("/api/settings", { widget_layout: JSON.stringify(draft) }),
    onSuccess: finishEdit,
  });
  // drop the personal override and follow the shared default again
  const followDefault = useMutation({
    mutationFn: () => api.patch("/api/auth/prefs", { layout: "" }),
    onSuccess: finishEdit,
  });
  const savingAny = saveMine.isPending || saveDefault.isPending || followDefault.isPending;

  const resetTarget = canEditDefault
    ? sharedDefault
    : sharedDefault.filter((i) => widgetAllowed(i.id));

  // ── edit-mode mutators ──────────────────────────────────────────
  const setCols = (index: number, delta: number) =>
    setDraft((d) =>
      d.map((item, i) => (i === index ? { ...item, cols: clampCols(item.cols + delta) } : item))
    );
  const setRows = (index: number, delta: number) =>
    setDraft((d) =>
      d.map((item, i) => (i === index ? { ...item, rows: clampRows(item.rows + delta) } : item))
    );
  const setOption = (index: number, key: string, value: string) =>
    setDraft((d) =>
      d.map((item, i) =>
        i === index ? { ...item, options: { ...item.options, [key]: value } } : item
      )
    );
  const setVisibility = (index: number, groups: number[]) =>
    setDraft((d) =>
      d.map((item, i) =>
        i === index ? { ...item, allowed_groups: groups.length ? groups : undefined } : item
      )
    );
  const remove = (index: number) => setDraft((d) => d.filter((_, i) => i !== index));
  const add = (id: string) =>
    setDraft((d) => [
      ...d,
      { id, cols: widgetById.get(id)?.defaultCols ?? 2, rows: defaultRowsFor(id) },
    ]);

  const reorder = (from: number, to: number) =>
    setDraft((d) => {
      if (from === to) return d;
      const next = [...d];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const beginResize = (event: React.PointerEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const item = draft[index];
    const meta = widgetById.get(item.id);
    const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 0;
    const styles = gridRef.current ? getComputedStyle(gridRef.current) : null;
    const gap = Number.parseFloat(styles?.columnGap || "20") || 20;
    const colWidth = (gridWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const rowUnit = Number.parseFloat(styles?.getPropertyValue("--row-unit") || "210") || 210;
    const startX = event.clientX;
    const startY = event.clientY;
    const startCols = item.cols;
    const startRows = item.rows;

    const move = (e: PointerEvent) => {
      const cols = clampCols(startCols + Math.round((e.clientX - startX) / (colWidth + gap)));
      const rows = meta?.resizableHeight
        ? clampRows(startRows + Math.round((e.clientY - startY) / (rowUnit + gap)))
        : startRows;
      setDraft((current) =>
        current.map((entry, i) => (i === index ? { ...entry, cols, rows } : entry))
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const missing = widgets.filter(
    (w) => !draft.some((item) => item.id === w.id) && widgetAllowed(w.id)
  );

  return (
    <>
      {editing && (
        <div className="dashboard-toolbar">
          <div className="edit-actions">
            {me.hasCustomLayout && (
              <button
                className="btn ghost"
                title="Discard your personal layout and follow the shared default"
                onClick={() => followDefault.mutate()}
                disabled={followDefault.isPending}
              >
                <RotateCcw size={15} /> Follow default
              </button>
            )}
            <button
              className="btn ghost"
              title="Reset to the shared default"
              onClick={() => setDraft(resetTarget)}
            >
              <RotateCcw size={15} /> Reset
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setDraft(saved);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            {canEditDefault && (
              <button
                className="btn ghost"
                title="Save this as the default everyone starts from"
                onClick={() => saveDefault.mutate()}
                disabled={savingAny}
              >
                Save as default
              </button>
            )}
            <button className="btn primary" onClick={() => saveMine.mutate()} disabled={savingAny}>
              <Check size={15} /> Save my layout
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="edit-banner">
          Drag the top handle to reorder, use −/+ for exact sizing, or drag a widget’s lower-right
          corner to resize it. <strong>Save my layout</strong> changes only your overview
          {canEditDefault ? "; Save as default sets what everyone starts from." : "."}
        </div>
      )}

      <div className="widget-grid" ref={gridRef}>
        {layout.map((item, index) => {
          const meta = widgetById.get(item.id);
          if (!meta) return null;
          const Widget = meta.component;
          const options = { ...defaultsFor(item.id), ...item.options };
          return (
            <div
              key={`${item.id}-${index}`}
              data-widget-id={item.id}
              className={`widget-slot${editing ? " editing" : ""}${
                dragIndex === index ? " dragging" : ""
              }`}
              style={
                {
                  ["--cols" as string]: item.cols,
                  ["--rows" as string]: item.rows,
                  ["--grid-rows" as string]: meta.compactHeight ? 2 : item.rows * 4,
                  ["--i" as string]: index,
                } as React.CSSProperties
              }
              draggable={editing}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(e) => {
                if (editing && dragIndex !== null) e.preventDefault();
              }}
              onDrop={() => {
                if (dragIndex !== null) reorder(dragIndex, index);
                setDragIndex(null);
              }}
            >
              {editing && (
                <div className="widget-editbar">
                  <GripVertical size={15} className="drag-handle" />
                  <span className="widget-editname">{meta.name}</span>
                  <div className="grow" />
                  <WidgetSettingsMenu
                    meta={meta}
                    options={options}
                    onOption={(key, value) => setOption(index, key, value)}
                    allowedGroups={item.allowed_groups ?? []}
                    onVisibility={(groups) => setVisibility(index, groups)}
                  />
                  <div className="col-stepper">
                    <button
                      className="btn ghost sm"
                      onClick={() => setCols(index, -1)}
                      disabled={item.cols <= (meta.minCols ?? 1)}
                      title="Narrower"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="col-count">
                      {item.cols}/{GRID_COLUMNS}
                    </span>
                    <button
                      className="btn ghost sm"
                      onClick={() => setCols(index, 1)}
                      disabled={item.cols >= GRID_COLUMNS}
                      title="Wider"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {meta.resizableHeight && (
                    <div className="col-stepper" title="Widget height">
                      <button
                        className="btn ghost sm"
                        onClick={() => setRows(index, -1)}
                        disabled={item.rows <= MIN_ROWS}
                        title="Shorter"
                      >
                        <Minus size={13} />
                      </button>
                      <span className="col-count">
                        <MoveVertical size={12} />
                        {item.rows}
                      </span>
                      <button
                        className="btn ghost sm"
                        onClick={() => setRows(index, 1)}
                        disabled={item.rows >= MAX_ROWS}
                        title="Taller"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  )}
                  <button
                    className="btn ghost sm remove"
                    onClick={() => remove(index)}
                    title="Remove widget"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="widget-frame">
                <Widget cols={item.cols} options={options} />
              </div>
              {editing && (
                <button
                  type="button"
                  className="widget-resize-handle"
                  aria-label={`Resize ${meta.name}`}
                  title="Drag to resize"
                  draggable={false}
                  onPointerDown={(event) => beginResize(event, index)}
                />
              )}
            </div>
          );
        })}
      </div>

      {editing && missing.length > 0 && (
        <div className="add-widget-row">
          <span className="add-widget-label">Add a widget:</span>
          {missing.map((w) => (
            <button key={w.id} className="btn sm" onClick={() => add(w.id)}>
              <Plus size={13} /> {w.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function defaultsFor(id: string): Record<string, string> {
  const meta = widgetById.get(id);
  const out: Record<string, string> = {};
  for (const opt of meta?.options ?? []) out[opt.key] = opt.default;
  return out;
}
