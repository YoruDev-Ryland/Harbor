import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import type { ContactInfo, NotifyCategory } from "../types";
import { applyTheme, themes } from "../theme/themes";
import { categoryEnabled, NOTIFY_CATEGORIES } from "../lib/notifications";
import { canSeeWidget } from "../lib/moduleAccess";
import PushPreferences from "./PushPreferences";
import { useDialogFocus } from "../lib/useDialogFocus";

export default function AccountModal({ onClose }: { onClose: () => void }) {
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["contact"],
    queryFn: () => api.get<ContactInfo>("/api/auth/contact"),
  });

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cats, setCats] = useState<Record<NotifyCategory, boolean>>({
    downloads: false,
    services: false,
    disk: false,
    websites: false,
  });
  const [downloadScope, setDownloadScope] = useState<"all" | "requested">("all");
  const [requestEmail, setRequestEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [theme, setTheme] = useState(me.user?.theme || me.defaultTheme);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true, onClose, '[aria-label="Close account settings"]');

  useEffect(() => {
    if (data) {
      setEmail(data.email ?? "");
      setPhone(data.phone ?? "");
      setDownloadScope(data.download_scope === "requested" ? "requested" : "all");
      setRequestEmail(data.request_email ?? "");
      setCats({
        downloads: categoryEnabled("downloads", data.notify_email, data.notify_prefs),
        services: categoryEnabled("services", data.notify_email, data.notify_prefs),
        disk: categoryEnabled("disk", data.notify_email, data.notify_prefs),
        websites: categoryEnabled("websites", data.notify_email, data.notify_prefs),
      });
    }
  }, [data]);

  const flash = (m: string) => {
    setMsg(m);
    setErr("");
  };
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : "failed");

  const setTheming = useMutation({
    mutationFn: (id: string) => api.patch("/api/auth/prefs", { theme: id }),
    onSuccess: () => refresh(),
  });
  const pickTheme = (id: string) => {
    setTheme(id);
    applyTheme(id);
    setTheming.mutate(id);
  };

  const saveContact = useMutation({
    mutationFn: () => api.patch("/api/auth/contact", { email, phone }),
    onSuccess: () => {
      flash("Contact details saved.");
      queryClient.invalidateQueries({ queryKey: ["contact"] });
      refresh();
    },
    onError: fail,
  });

  // only offer notifications for modules this user can actually see
  const visibleCats = NOTIFY_CATEGORIES.filter((c) => canSeeWidget(me, c.widget));

  const showDownloads = visibleCats.some((c) => c.category === "downloads");

  const saveNotify = useMutation({
    mutationFn: () => {
      const prefs = Object.fromEntries(visibleCats.map((c) => [c.category, cats[c.category]]));
      return api.patch("/api/auth/contact", {
        // master stays roughly in sync; per-category overrides are the source of truth
        notify_email: Object.values(prefs).some(Boolean),
        notify_prefs: prefs,
        ...(showDownloads
          ? { download_scope: downloadScope, request_email: requestEmail.trim() }
          : {}),
      });
    },
    onSuccess: () => {
      flash("Notification preferences saved.");
      queryClient.invalidateQueries({ queryKey: ["contact"] });
    },
    onError: fail,
  });

  const changePw = useMutation({
    mutationFn: () =>
      api.post("/api/auth/password", { current: current || undefined, password: next }),
    onSuccess: () => {
      flash("Password updated.");
      setCurrent("");
      setNext("");
    },
    onError: fail,
  });

  const hasEmail = email.trim().length > 0;

  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="account-head">
          <h3 id="account-dialog-title">Account · {me.user!.username}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close account settings">
            <X size={16} />
          </button>
        </div>

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

        <section className="account-section">
          <h4>Appearance</h4>
          <div className="theme-grid">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-chip${theme === t.id ? " on" : ""}`}
                onClick={() => pickTheme(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </section>

        <section className="account-section">
          <h4>Contact details</h4>
          <p className="account-sub">Used to reach you for notifications you’ve opted into.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="account-email">Email</label>
              <input
                id="account-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="account-phone">Phone (for future SMS)</label>
              <input
                id="account-phone"
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 000 1234"
              />
            </div>
          </div>
          <button
            className="btn primary"
            style={{ marginTop: 10 }}
            disabled={saveContact.isPending}
            onClick={() => saveContact.mutate()}
          >
            Save contact details
          </button>
        </section>

        {visibleCats.length > 0 && (
          <section className="account-section">
            <h4>Notifications</h4>
            <p className="account-sub">
              Choose which events email you{hasEmail ? "" : " — add an email above first"}.
            </p>
            <div className="notify-list">
              {visibleCats.map((c) => (
                <label className="notify-row" key={c.category}>
                  <input
                    type="checkbox"
                    checked={cats[c.category]}
                    onChange={(e) => setCats((s) => ({ ...s, [c.category]: e.target.checked }))}
                  />
                  <span className="notify-copy">
                    <span className="notify-name">{c.label}</span>
                    <span className="notify-hint">{c.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {showDownloads && cats.downloads && (
              <div className="notify-sub">
                <div className="notify-sub-label">Which finished downloads email me?</div>
                <div className="vis-picker">
                  <button
                    type="button"
                    className={`filter-chip${downloadScope === "all" ? " on" : ""}`}
                    onClick={() => setDownloadScope("all")}
                  >
                    All downloads
                  </button>
                  <button
                    type="button"
                    className={`filter-chip${downloadScope === "requested" ? " on" : ""}`}
                    onClick={() => setDownloadScope("requested")}
                  >
                    Only what I requested
                  </button>
                </div>
                {downloadScope === "requested" && (
                  <div className="field" style={{ marginTop: 8 }}>
                    <label htmlFor="account-request-email">Request account email (optional)</label>
                    <input
                      id="account-request-email"
                      className="input"
                      type="email"
                      value={requestEmail}
                      onChange={(e) => setRequestEmail(e.target.value)}
                      placeholder={email || "you@example.com"}
                    />
                    <p className="notify-hint">
                      Matched against your requests in Seerr / Jellyseerr. Leave blank to use your
                      account email above.
                    </p>
                  </div>
                )}
              </div>
            )}

            <button
              className="btn primary"
              style={{ marginTop: 10 }}
              disabled={saveNotify.isPending}
              onClick={() => saveNotify.mutate()}
            >
              Save notification preferences
            </button>
          </section>
        )}

        <PushPreferences />

        <section className="account-section">
          <h4>Password</h4>
          {!me.user!.has_password ? (
            <p className="sub">
              This account has no local password. A credential manager must issue a short-lived,
              one-time reset link before a local password can be established.
            </p>
          ) : (
            <>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="account-current-password">Current password</label>
                  <input
                    id="account-current-password"
                    className="input"
                    type="password"
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="account-new-password">New password (min 12)</label>
                  <input
                    id="account-new-password"
                    className="input"
                    type="password"
                    minLength={12}
                    maxLength={256}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                  />
                </div>
              </div>
              <button
                className="btn"
                style={{ marginTop: 10 }}
                disabled={next.length < 12 || changePw.isPending}
                onClick={() => changePw.mutate()}
              >
                Change password
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
