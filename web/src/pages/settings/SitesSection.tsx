import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Monitor } from "../../types";

interface SiteForm {
  name: string;
  url: string;
  expect_status: string; // "" = any
  keyword: string;
  enabled: boolean;
}

const empty: SiteForm = { name: "", url: "", expect_status: "", keyword: "", enabled: true };

export default function SitesSection() {
  const queryClient = useQueryClient();
  const { data: sites = [] } = useQuery({
    queryKey: ["monitors"],
    queryFn: () => api.get<Monitor[]>("/api/monitors"),
    refetchInterval: 20_000,
  });

  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<SiteForm>(empty);
  const [err, setErr] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["monitors"] });
    queryClient.invalidateQueries({ queryKey: ["widget", "websites"] });
    setEditing(null);
    setErr("");
  };
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : "failed");

  const payload = () => ({
    name: form.name,
    url: form.url,
    keyword: form.keyword || null,
    expect_status: form.expect_status ? Number(form.expect_status) : null,
    enabled: form.enabled,
  });

  const save = useMutation({
    mutationFn: () =>
      editing === "new"
        ? api.post("/api/monitors", payload())
        : api.patch(`/api/monitors/${editing}`, payload()),
    onSuccess: invalidate,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/monitors/${id}`),
    onSuccess: invalidate,
    onError: fail,
  });
  const check = useMutation({
    mutationFn: (id: number) => api.post(`/api/monitors/${id}/check`),
    onSuccess: invalidate,
    onError: fail,
  });

  const startEdit = (m?: Monitor) => {
    setErr("");
    if (m) {
      setEditing(m.id);
      setForm({
        name: m.name,
        url: m.url,
        expect_status: m.expect_status ? String(m.expect_status) : "",
        keyword: m.keyword ?? "",
        enabled: m.enabled,
      });
    } else {
      setEditing("new");
      setForm(empty);
    }
  };

  return (
    <div className="card">
      <h3>Sites — website monitoring</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        Harbor checks each site every minute — not just a ping. It watches the HTTP status, scans
        for crash signatures (WordPress fatal errors, database errors, gateway failures), and can
        require a keyword that must appear on a healthy page. Transitions raise notifications.
      </p>
      {err && <div className="auth-error">{err}</div>}

      <div className="row-list">
        {sites.map((m) => (
          <div className="row-item" key={m.id}>
            <span className={`site-dot state-${m.state ?? "pending"}`} />
            <div className="grow">
              <div className="title">
                {m.name}
                {!m.enabled ? " · paused" : ""}
              </div>
              <div className="sub">
                {m.url}
                {m.state ? ` · ${m.state}` : " · not checked yet"}
                {m.status ? ` · HTTP ${m.status}` : ""}
                {m.uptime != null ? ` · ${m.uptime}% 24h` : ""}
                {m.message && (m.state === "error" || m.state === "changed" || m.state === "down")
                  ? ` · ${m.message}`
                  : ""}
              </div>
            </div>
            <button className="btn ghost sm" title="Check now" onClick={() => check.mutate(m.id)}>
              <RefreshCw size={13} />
            </button>
            <button className="btn ghost sm" onClick={() => startEdit(m)}>
              <Pencil size={13} />
            </button>
            <button className="btn ghost sm" onClick={() => remove.mutate(m.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {sites.length === 0 && <div className="widget-empty">No sites watched yet.</div>}
      </div>

      {editing === null ? (
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => startEdit()}>
          <Plus size={15} /> Watch a site
        </button>
      ) : (
        <form
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="form-grid">
            <div className="field">
              <label>Name</label>
              <input
                className="input"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Client blog"
              />
            </div>
            <div className="field">
              <label>URL</label>
              <input
                className="input"
                required
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com"
              />
            </div>
            <div className="field">
              <label>Expected status (blank = any non-error)</label>
              <input
                className="input"
                type="number"
                value={form.expect_status}
                onChange={(e) => setForm({ ...form, expect_status: e.target.value })}
                placeholder="200"
              />
            </div>
            <div className="field">
              <label>Required keyword (optional)</label>
              <input
                className="input"
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
                placeholder="e.g. your site title / footer text"
              />
            </div>
            <label className="check-row full">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Actively monitor this site
            </label>
          </div>
          <p className="sub" style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-faint)" }}>
            A keyword is the strongest crash signal: pick text that always appears on a healthy page
            (a title, footer, or nav item). If WordPress dies, its error page won’t contain it.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary" disabled={save.isPending}>
              {editing === "new" ? "Add site" : "Save"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
