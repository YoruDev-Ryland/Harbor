import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { BrandMark } from "../components/Icon";

export default function AcceptInvite() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get("token") ?? "", [params]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return setError("passwords do not match");
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/invite", { token, password });
      refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "invitation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <span className="brand-name">{me.title || "Harbor"}</span>
        </div>
        <p className="tagline">Join the crew</p>
        <p className="muted">Choose a local password to activate this one-time invitation.</p>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {!token && (
          <div className="auth-error" role="alert">
            Invitation token is missing.
          </div>
        )}
        <div className="field">
          <label htmlFor="invite-password">Password (12–256 characters)</label>
          <input
            id="invite-password"
            className="input"
            type="password"
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="invite-confirm">Confirm password</label>
          <input
            id="invite-confirm"
            className="input"
            type="password"
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <button
          className="btn primary"
          style={{ width: "100%" }}
          disabled={!token || password.length < 12 || busy}
        >
          {busy ? "Joining…" : "Activate account"}
        </button>
      </form>
    </main>
  );
}
