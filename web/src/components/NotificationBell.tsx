import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCircle2, Info, XCircle } from "lucide-react";
import { api } from "../api";
import type { AppNotification, NotificationsResponse, NotifyKind } from "../types";

function KindIcon({ kind }: { kind: NotifyKind }) {
  if (kind === "success") return <CheckCircle2 size={15} className="note-ic success" />;
  if (kind === "warn") return <AlertTriangle size={15} className="note-ic warn" />;
  if (kind === "error") return <XCircle size={15} className="note-ic error" />;
  return <Info size={15} className="note-ic info" />;
}

function timeAgo(iso: string): string {
  const then = new Date(iso.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationsResponse>("/api/notifications"),
    refetchInterval: 30_000,
  });
  const markSeen = useMutation({
    mutationFn: () => api.post("/api/notifications/seen"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const clearAll = useMutation({
    mutationFn: () => api.del("/api/notifications"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) markSeen.mutate();
  };

  return (
    <div className="note-wrap" ref={ref}>
      {open && (
        <div className="note-panel" role="menu">
          <div className="note-head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button
                className="note-clear"
                onClick={() => clearAll.mutate()}
                disabled={clearAll.isPending}
              >
                Clear
              </button>
            )}
          </div>
          <div className="note-list">
            {items.length === 0 ? (
              <div className="note-empty">All quiet on the water.</div>
            ) : (
              items.map((n: AppNotification) => (
                <div className="note-item" key={n.id}>
                  <KindIcon kind={n.kind} />
                  <div className="note-body">
                    <div className="note-title">{n.title}</div>
                    {n.body && <div className="note-text">{n.body}</div>}
                    <div className="note-time">{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <button
        className={`nav-item note-toggle${open ? " open" : ""}`}
        onClick={toggle}
        title="Notifications"
      >
        <span className="note-bell">
          <Bell size={17} className="nav-icon" />
          {unread > 0 && <span className="note-badge">{unread > 9 ? "9+" : unread}</span>}
        </span>
        <span>Notifications</span>
      </button>
    </div>
  );
}
