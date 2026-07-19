import { useState } from "react";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { BrandMark } from "../components/Icon";

export default function Setup() {
  const { refresh } = useSession();
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/setup", { setupToken, username, password, email });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "setup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Harbor</span>
        </div>
        <p className="tagline">First light. Create the harbormaster account.</p>
        <p className="muted">
          Enter the one-time setup token from the container logs or configured Docker secret.
        </p>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="setup-token">Setup token</label>
          <input
            id="setup-token"
            className="input"
            maxLength={256}
            type="password"
            autoComplete="one-time-code"
            autoFocus
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="input"
            maxLength={64}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="email">Email (optional)</label>
          <input
            id="email"
            className="input"
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password (12+ characters)</label>
          <input
            id="password"
            className="input"
            type="password"
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Raising the flag…" : "Take the helm"}
        </button>
      </form>
    </main>
  );
}
