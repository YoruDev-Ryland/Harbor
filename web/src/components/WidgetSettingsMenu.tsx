import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { useSession } from "../App";
import { can } from "../lib/perms";
import type { WidgetMeta } from "../widgets/registry";
import GroupVisibility from "./GroupVisibility";

export default function WidgetSettingsMenu({
  meta,
  options,
  onOption,
  allowedGroups,
  onVisibility,
}: {
  meta: WidgetMeta;
  options: Record<string, unknown>;
  onOption: (key: string, value: string) => void;
  allowedGroups: number[];
  onVisibility: (groups: number[]) => void;
}) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // shared calendar behaviour is an appearance-level default; per-group module
  // visibility belongs to whoever edits the shared default layout
  const canEditActions = can(me.user, "manageSettings");
  const canEditVisibility = can(me.user, "editLayout");

  const hasOptions = (meta.options?.length ?? 0) > 0;
  const Panel = meta.settingsPanel;
  const width = Panel ? 340 : 260;

  // Portal + fixed positioning so no ancestor's overflow/transform can clip it.
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      const top = r.bottom + 6;
      setPos({ top, left, maxH: Math.max(160, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // nothing to show if there are no user options, no custom panel, and this user
  // can't set visibility
  if (!hasOptions && !Panel && !canEditVisibility) return null;

  return (
    <div className="wset">
      <button
        ref={btnRef}
        type="button"
        className="btn ghost sm"
        onClick={() => setOpen((o) => !o)}
        title="Widget settings"
        aria-expanded={open}
      >
        <Settings2 size={14} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={`wset-pop${Panel ? " wide" : ""}`}
            role="menu"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              right: "auto",
              width,
              maxHeight: pos.maxH,
              overflowY: "auto",
              zIndex: 150,
            }}
          >
            <div className="wset-title">{meta.name} settings</div>

            {meta.options?.map((opt) => (
              <label className="wset-field" key={opt.key}>
                <span>{opt.label}</span>
                <select
                  className="edit-select"
                  value={String(options[opt.key] ?? opt.default)}
                  onChange={(e) => onOption(opt.key, e.target.value)}
                >
                  {opt.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            {Panel && <Panel isAdmin={canEditActions} />}

            {canEditVisibility && (
              <>
                <div className="wset-sep">Visible to (default layout)</div>
                <GroupVisibility value={allowedGroups} onChange={onVisibility} />
                <p className="wset-hint">Applies when you save as the shared default.</p>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
