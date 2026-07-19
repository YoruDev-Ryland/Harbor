import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { useDialogFocus } from "../lib/useDialogFocus";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  section: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

/** subsequence match with light scoring; returns -1 for no match */
function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx; // contiguous substring — best
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    ti = t.indexOf(q[qi], ti);
    if (ti < 0) return -1;
    ti++;
  }
  return 10; // scattered subsequence
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open, onClose, ".cmd-input");

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: score(query, `${c.label} ${c.keywords ?? ""}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  // keep the highlighted row in view
  useEffect(() => {
    listRef.current?.querySelector(".cmd-row.active")?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="cmd-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmd-input-row">
          <Search size={16} className="cmd-search-icon" />
          <input
            ref={inputRef}
            className="cmd-input"
            aria-label="Search commands"
            placeholder="Jump to a berth, run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className="cmd-kbd">esc</kbd>
        </div>
        <div className="cmd-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmd-empty">No matches</div>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                className={`cmd-row${i === active ? " active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => runAt(i)}
              >
                <span className="cmd-icon">{c.icon}</span>
                <span className="cmd-label">{c.label}</span>
                <span className="cmd-section">{c.section}</span>
                {i === active && <CornerDownLeft size={13} className="cmd-enter" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
