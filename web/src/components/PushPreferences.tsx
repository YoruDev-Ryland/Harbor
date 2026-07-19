import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Send } from "lucide-react";
import { api, ApiError } from "../api";
import type { PushConfig } from "../types";

export default function PushPreferences() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["push", "me"],
    queryFn: () => api.get<PushConfig>("/api/notifications/push/me"),
  });
  const [form, setForm] = useState({ enabled: false, url: "http://ntfy", topic: "" });
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!data) return;
    setForm({ enabled: data.enabled, url: data.url, topic: data.topic });
    setHasToken(data.hasToken);
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.patch("/api/notifications/push/me", { ...form, ...(token ? { token } : {}) }),
    onSuccess: () => {
      setToken("");
      setMsg("Private push endpoint saved.");
      setErr("");
      queryClient.invalidateQueries({ queryKey: ["push", "me"] });
    },
    onError: (error) => setErr(error instanceof ApiError ? error.message : "save failed"),
  });
  const test = useMutation({
    mutationFn: () => api.post("/api/notifications/push/me/test", {}),
    onSuccess: () => {
      setMsg("Test push sent.");
      setErr("");
    },
    onError: (error) => setErr(error instanceof ApiError ? error.message : "test failed"),
  });

  return (
    <section className="account-section">
      <h4>Private phone push (ntfy)</h4>
      <p className="account-sub">
        This endpoint belongs only to your Harbor account. Use your own ntfy topic and subscriber
        credentials; Harbor sends only events you are allowed to see.
      </p>
      {msg && (
        <div className="auth-note" role="status">
          {msg}
        </div>
      )}
      {err && (
        <div className="auth-error" role="alert">
          {err}
        </div>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
        />
        Enable my private push endpoint
      </label>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <div className="field">
          <label htmlFor="account-ntfy-url">ntfy server URL</label>
          <input
            id="account-ntfy-url"
            className="input"
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
            placeholder="http://ntfy"
          />
        </div>
        <div className="field">
          <label htmlFor="account-ntfy-topic">Private topic</label>
          <input
            id="account-ntfy-topic"
            className="input"
            value={form.topic}
            onChange={(event) => setForm({ ...form, topic: event.target.value })}
            placeholder="harbor-alice"
          />
        </div>
        <div className="field full">
          <label htmlFor="account-ntfy-token">
            Publisher token {hasToken ? "(leave blank to keep)" : "(optional)"}
          </label>
          <input
            id="account-ntfy-token"
            className="input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={hasToken ? "••••••••" : "tk_…"}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          <BellRing size={14} /> Save push
        </button>
        <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
          <Send size={14} /> Test
        </button>
      </div>
    </section>
  );
}
