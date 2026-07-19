import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

interface AuditEvent {
  id: number;
  actor_username: string | null;
  action: string;
  target: string | null;
  status: number;
  remote_address: string | null;
  created_at: string;
}

export default function AuditSection() {
  const { data = [], isLoading } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<AuditEvent[]>("/api/audit?limit=200"),
  });
  return (
    <div className="card">
      <h3>Security audit log</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        Bounded records of authentication, account, permission, integration, notification, backup,
        and destructive API activity. Request bodies and credentials are never recorded.
      </p>
      {isLoading ? (
        <p className="sub">Loading…</p>
      ) : (
        <div className="row-list">
          {data.map((event) => (
            <div className="row-item" key={event.id}>
              <div className="grow">
                <div className="title">{event.action}</div>
                <div className="sub">
                  {event.actor_username || "anonymous"} · HTTP {event.status} ·{" "}
                  {event.remote_address || "unknown peer"}
                  {event.target ? ` · ${event.target}` : ""}
                </div>
              </div>
              <div className="sub">{new Date(event.created_at + "Z").toLocaleString()}</div>
            </div>
          ))}
          {!data.length && <p className="sub">No audit events yet.</p>}
        </div>
      )}
    </div>
  );
}
