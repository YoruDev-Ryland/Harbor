import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "../api";
import type { StorageMount, StorageResponse } from "../types";
import type { WidgetProps } from "./registry";

/** bytes → compact "1.2 TB" */
function humanBytes(n?: number): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** used% → severity class so a nearly-full disk reads at a glance */
function fillClass(usedPct: number): string {
  if (usedPct >= 90) return "danger";
  if (usedPct >= 75) return "warn";
  return "ok";
}

function MountRow({ m }: { m: StorageMount }) {
  const free = humanBytes(m.freeBytes);
  const total = humanBytes(m.totalBytes);
  const right = free && total ? `${free} free of ${total}` : `${Math.round(m.usedPct)}% used`;
  return (
    <div className="stor-item">
      <div className="stor-top">
        <span className="stor-label" title={m.path ?? m.label}>
          {m.label}
        </span>
        <span className="stor-right">{right}</span>
      </div>
      <div className="progress stor-bar">
        <div
          className={`progress-fill stor-fill ${fillClass(m.usedPct)}`}
          style={{ width: `${Math.min(100, Math.max(2, m.usedPct))}%` }}
        />
      </div>
    </div>
  );
}

export default function StorageWidget(_props: WidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget", "storage"],
    queryFn: () => api.get<StorageResponse>("/api/widgets/storage"),
    refetchInterval: 120_000,
  });

  const mounts = data?.mounts ?? [];

  return (
    <section className="widget">
      <header className="panel-head">
        <span className="panel-tag">
          <HardDrive size={12} />
          <span>Storage</span>
        </span>
        {mounts.length > 0 && <span className="panel-meta">{mounts.length}</span>}
      </header>

      <div className="widget-body">
        {data?.errors.map((e) => (
          <div className="widget-error" key={e.source.id}>
            {e.source.name}: {e.message}
          </div>
        ))}
        {isLoading ? (
          <div className="widget-empty">Measuring the shelves…</div>
        ) : mounts.length === 0 ? (
          <div className="widget-empty">
            No disks reported. Add Sonarr/Radarr or Beszel under Harbormaster → Integrations.
          </div>
        ) : (
          <div className="stor-list">
            {mounts.map((m) => (
              <MountRow key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
