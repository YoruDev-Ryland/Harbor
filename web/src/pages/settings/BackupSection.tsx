import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { api, ApiError } from "../../api";

type Section =
  | "settings"
  | "groups"
  | "integrations"
  | "tabs"
  | "users"
  | "monitors"
  | "notifications"
  | "audit";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "tabs", label: "Berths" },
  { key: "integrations", label: "Integrations (encrypted secrets)" },
  { key: "groups", label: "Permission groups" },
  { key: "settings", label: "Settings, layout & SMTP" },
  { key: "users", label: "Users, identities and private push endpoints" },
  { key: "monitors", label: "Website monitors and retained history" },
  { key: "notifications", label: "Per-user notification feeds" },
  { key: "audit", label: "Security audit history" },
];

export default function BackupSection() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<any>(null); // parsed file awaiting confirm
  const [include, setInclude] = useState<Record<Section, boolean>>({
    tabs: true,
    integrations: true,
    groups: true,
    settings: true,
    users: true,
    monitors: true,
    notifications: true,
    audit: true,
  });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const exportNow = async () => {
    try {
      const data = await api.get<Record<string, unknown>>("/api/config/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `harbor-sensitive-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "export failed");
    }
  };

  const onFile = async (file: File) => {
    setErr("");
    setMsg("");
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.harbor !== "backup" || parsed?.version !== 3)
        throw new Error("not a supported Harbor backup file");
      setPending(parsed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not read file");
    }
  };

  const doImport = useMutation({
    mutationFn: () => api.post("/api/config/import", { data: pending, include }),
    onSuccess: () => {
      setMsg("Configuration restored.");
      setErr("");
      setPending(null);
      queryClient.invalidateQueries();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "import failed"),
  });

  return (
    <div className="card">
      <h3>Backup &amp; restore</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        This complete sensitive export contains password hashes, contacts, encrypted service and
        private-push credentials, calendar-token digests, monitor history, notifications, and audit
        history. It restores only with the same HARBOR_SECRET. Preserve the entire stopped data
        volume—including .secret and all SQLite files—for disaster recovery as well.
      </p>
      {msg && <div className="auth-note">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={exportNow}>
          <Download size={15} /> Export sensitive backup
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Upload size={15} /> Choose a file to restore…
        </button>
      </div>

      {pending && (
        <div className="contact-editor" style={{ marginTop: 14 }}>
          <div className="title" style={{ marginBottom: 8 }}>
            Restore backup taken {new Date(pending.exportedAt).toLocaleString()}
          </div>
          <p className="account-sub">
            Choose which sections to overwrite. Restore related sections together; the operation is
            transactional and rolls back completely if references or the administrator invariant
            fail.
          </p>
          {SECTIONS.map((s) => (
            <label className="check-row" key={s.key}>
              <input
                type="checkbox"
                checked={include[s.key]}
                onChange={(e) => setInclude({ ...include, [s.key]: e.target.checked })}
              />
              {s.label}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="btn primary"
              disabled={doImport.isPending}
              onClick={() => doImport.mutate()}
            >
              Restore selected
            </button>
            <button className="btn ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
