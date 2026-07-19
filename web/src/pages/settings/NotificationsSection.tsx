import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailCheck, Send } from "lucide-react";
import { api, ApiError } from "../../api";
import type { SmtpConfig } from "../../types";
import { useSession } from "../../App";
import { can } from "../../lib/perms";

export default function NotificationsSection() {
  return <EmailCard />;
}

function EmailCard() {
  const { me } = useSession();
  const canConfigure = can(me.user, "manageNotifications");
  const canManageSecrets = can(me.user, "manageSecrets");
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["smtp"],
    queryFn: () => api.get<SmtpConfig>("/api/notifications/smtp"),
  });

  const [form, setForm] = useState({
    enabled: false,
    host: "relay",
    port: 25,
    secure: false,
    allowInsecureTls: false,
    user: "",
    from: "Harbor <harbor@localhost>",
  });
  const [pass, setPass] = useState("");
  const [hasPass, setHasPass] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (data) {
      setForm({
        enabled: data.enabled,
        host: data.host,
        port: data.port,
        secure: data.secure,
        allowInsecureTls: data.allowInsecureTls,
        user: data.user,
        from: data.from,
      });
      setHasPass(data.hasPass);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(
        "/api/notifications/smtp",
        canConfigure ? { ...form, ...(pass ? { pass } : {}) } : { ...(pass ? { pass } : {}) }
      ),
    onSuccess: () => {
      setMsg("SMTP settings saved.");
      setErr("");
      setPass("");
      queryClient.invalidateQueries({ queryKey: ["smtp"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed"),
  });

  const test = useMutation({
    mutationFn: () =>
      api.post<{ sentTo: string | null }>("/api/notifications/smtp/test", { to: testTo }),
    onSuccess: (r) => {
      setMsg(r.sentTo ? `Test message sent to ${r.sentTo}.` : "SMTP connection verified.");
      setErr("");
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "SMTP test failed"),
  });

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="card">
      <h3>Notifications & email</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        Harbor emails users who opt in (Account → Contact details) when it raises an alert — a
        service going down, a download finishing, or a disk filling up. Point it at your mail relay;
        an internal relay usually needs just a host and no auth.
      </p>
      {msg && <div className="auth-note">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
      {data?.customCa && (
        <div className="auth-note">A mounted custom SMTP CA bundle is active.</div>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={form.enabled}
          disabled={!canConfigure}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Enable outgoing email
      </label>

      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="field">
          <label>SMTP host</label>
          <input
            className="input"
            disabled={!canConfigure}
            value={form.host}
            onChange={(e) => set({ host: e.target.value })}
            placeholder="relay"
          />
        </div>
        <div className="field">
          <label>Port</label>
          <input
            className="input"
            type="number"
            disabled={!canConfigure}
            value={form.port}
            onChange={(e) => set({ port: Number(e.target.value) })}
          />
        </div>
        <div className="field full">
          <label>From address</label>
          <input
            className="input"
            disabled={!canConfigure}
            value={form.from}
            onChange={(e) => set({ from: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Username (optional)</label>
          <input
            className="input"
            disabled={!canConfigure}
            value={form.user}
            onChange={(e) => set({ user: e.target.value })}
            placeholder="(none for an open relay)"
          />
        </div>
        <div className="field">
          <label>Password {hasPass ? "(leave blank to keep)" : "(optional)"}</label>
          <input
            className="input"
            type="password"
            disabled={!canManageSecrets}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={hasPass ? "••••••••" : ""}
          />
        </div>
        <label className="check-row full">
          <input
            type="checkbox"
            disabled={!canConfigure}
            checked={form.secure}
            onChange={(e) => set({ secure: e.target.checked })}
          />
          Use implicit TLS (port 465). Leave off for STARTTLS / plain relay.
        </label>
        <label className="check-row full">
          <input
            type="checkbox"
            disabled={!canManageSecrets}
            checked={form.allowInsecureTls}
            onChange={(e) => set({ allowInsecureTls: e.target.checked })}
          />
          Allow an untrusted/self-signed TLS certificate (unsafe; private relay only)
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          <MailCheck size={15} /> Save
        </button>
        {canConfigure && (
          <input
            className="input"
            style={{ width: 220 }}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="test recipient (or your email)"
          />
        )}
        {canConfigure && (
          <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
            <Send size={15} /> Send test
          </button>
        )}
      </div>
    </div>
  );
}
