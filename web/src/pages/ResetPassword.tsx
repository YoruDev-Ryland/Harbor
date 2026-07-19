import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { BrandMark } from "../components/Icon";

export default function ResetPassword() {
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
      await api.post("/api/auth/reset", { token, password });
      refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "password reset failed");
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
        <p className="tagline">Set a new password</p>
        <p className="muted">This one-time link expires after 15 minutes.</p>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {!token && (
          <div className="auth-error" role="alert">
            Reset token is missing.
          </div>
        )}
        <div className="field">
          <label htmlFor="reset-password">New password (12–256 characters)</label>
          <input
            id="reset-password"
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
          <label htmlFor="reset-confirm">Confirm password</label>
          <input
            id="reset-confirm"
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
          {busy ? "Updating…" : "Set password"}
        </button>
      </form>
    </main>
  );
}
