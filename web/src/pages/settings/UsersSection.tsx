import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  Plus,
  Trash2,
  Unlink,
} from "lucide-react";
import { api, ApiError } from "../../api";
import type { AdminUser, Group, Permission } from "../../types";
import { useSession } from "../../App";
import { can } from "../../lib/perms";

interface ResetResult {
  token: string;
  resetPath: string;
  resetUrl: string | null;
  expiresAt: string;
}

interface InviteResult {
  token: string;
  invitePath: string;
  inviteUrl: string | null;
  expiresAt: string;
}

export default function UsersSection() {
  const { me } = useSession();
  const canManageUsers = can(me.user, "manageUsers");
  const canManageCredentials = can(me.user, "manageCredentials");
  const queryClient = useQueryClient();
  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<AdminUser[]>("/api/users"),
  });
  const { data: groups = [] } = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<Group[]>("/api/groups"),
    enabled: canManageUsers,
  });
  const defaultGroupId = groups.find((g) => g.is_default)?.id ?? groups[0]?.id;

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{
    username: string;
    email: string;
    password: string;
    group_id: number | "";
  }>({ username: "", email: "", password: "", group_id: "" });
  const [error, setError] = useState("");
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [identityUserId, setIdentityUserId] = useState<number | null>(null);
  const [identity, setIdentity] = useState({ provider: "proxy", subject: "" });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["groups"] });
    queryClient.invalidateQueries({ queryKey: ["me"] });
    setAdding(false);
    setError("");
    setForm({ username: "", email: "", password: "", group_id: "" });
  };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "failed");

  const create = useMutation({
    mutationFn: () =>
      api.post("/api/users", { ...form, group_id: form.group_id || defaultGroupId }),
    onSuccess: invalidate,
    onError: fail,
  });
  const invite = useMutation({
    mutationFn: () =>
      api.post<InviteResult>("/api/users/invites", {
        username: form.username,
        email: form.email,
        group_id: form.group_id || defaultGroupId,
      }),
    onSuccess: (result) => {
      setInviteResult(result);
      setAdding(false);
      setError("");
      setForm({ username: "", email: "", password: "", group_id: "" });
    },
    onError: fail,
  });
  const setGroup = useMutation({
    mutationFn: ({ id, group_id }: { id: number; group_id: number }) =>
      api.patch(`/api/users/${id}`, { group_id }),
    onSuccess: invalidate,
    onError: fail,
  });
  const saveContact = useMutation({
    mutationFn: (v: { id: number; email: string; phone: string; notify_email: boolean }) =>
      api.patch(`/api/users/${v.id}`, {
        email: v.email,
        phone: v.phone,
        notify_email: v.notify_email,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setContactId(null);
    },
    onError: fail,
  });

  const [contactId, setContactId] = useState<number | null>(null);
  const [contact, setContact] = useState({ email: "", phone: "", notify_email: false });
  const openContact = (u: AdminUser) => {
    setContactId(u.id);
    setContact({ email: u.email ?? "", phone: u.phone ?? "", notify_email: !!u.notify_email });
  };
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    onSuccess: invalidate,
    onError: fail,
  });
  const setDisabled = useMutation({
    mutationFn: ({ id, disabled }: { id: number; disabled: boolean }) =>
      api.patch(`/api/users/${id}`, { disabled }),
    onSuccess: invalidate,
    onError: fail,
  });
  const issueReset = useMutation({
    mutationFn: (id: number) => api.post<ResetResult>(`/api/users/${id}/password-reset`),
    onSuccess: (result) => {
      setResetResult(result);
      setError("");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: fail,
  });
  const logoutAll = useMutation({
    mutationFn: (id: number) => api.post(`/api/users/${id}/logout-all`),
    onSuccess: () => setError(""),
    onError: fail,
  });
  const bindIdentity = useMutation({
    mutationFn: (id: number) => api.post(`/api/users/${id}/identities`, identity),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setIdentity({ provider: "proxy", subject: "" });
      setError("");
    },
    onError: fail,
  });
  const unbindIdentity = useMutation({
    mutationFn: ({ userId, identityId }: { userId: number; identityId: number }) =>
      api.del(`/api/users/${userId}/identities/${identityId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: fail,
  });

  return (
    <div className="card">
      <h3>Crew</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        SSO users are provisioned into the default group on first visit. Change a member’s group to
        adjust what they can see and do — configure the groups themselves under Groups.
      </p>
      {error && <div className="auth-error">{error}</div>}
      {resetResult && (
        <div className="contact-editor" style={{ marginBottom: 12 }}>
          <strong>One-time reset link</strong>
          <p className="sub">
            Share this securely. It expires {new Date(resetResult.expiresAt).toLocaleString()} and
            will not be shown again.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input grow"
              readOnly
              value={resetResult.resetUrl ?? `${window.location.origin}${resetResult.resetPath}`}
            />
            <button
              className="btn sm"
              onClick={() =>
                navigator.clipboard.writeText(
                  resetResult.resetUrl ?? `${window.location.origin}${resetResult.resetPath}`
                )
              }
            >
              <Copy size={13} /> Copy
            </button>
            <button className="btn ghost sm" onClick={() => setResetResult(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {inviteResult && (
        <div className="contact-editor" style={{ marginBottom: 12 }}>
          <strong>One-time invitation</strong>
          <p className="sub">
            Share this privately. It expires {new Date(inviteResult.expiresAt).toLocaleString()} and
            will not be shown again.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input grow"
              readOnly
              value={
                inviteResult.inviteUrl ?? `${window.location.origin}${inviteResult.invitePath}`
              }
            />
            <button
              className="btn sm"
              onClick={() =>
                navigator.clipboard.writeText(
                  inviteResult.inviteUrl ?? `${window.location.origin}${inviteResult.invitePath}`
                )
              }
            >
              <Copy size={13} /> Copy
            </button>
            <button className="btn ghost sm" onClick={() => setInviteResult(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div className="row-list">
        {users.map((user) => {
          const userGroup = groups.find((group) => group.id === user.group_id);
          const protectedAdmin = !!user.is_admin && !me.user?.permissions.admin;
          const protectedManageTarget =
            protectedAdmin ||
            (!!userGroup &&
              Object.entries(userGroup.effective).some(
                ([permission, enabled]) =>
                  enabled && !me.user?.permissions[permission as Permission]
              ));
          const isSelf = user.id === me.user?.id;
          return (
            <div key={user.id}>
              <div className="row-item">
                <div
                  className="avatar"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    background: "var(--accent)",
                    color: "var(--accent-contrast)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {user.username.slice(0, 1).toUpperCase()}
                </div>
                <div className="grow">
                  <div className="title">{user.username}</div>
                  <div className="sub">
                    {user.disabled ? "disabled · " : ""}
                    {user.email ?? "no email"}
                    {user.group_name ? ` · ${user.group_name}` : ""}
                    {user.phone ? ` · ${user.phone}` : ""}
                    {user.notify_email ? " · ✉ alerts" : ""} · last aboard{" "}
                    {user.last_login
                      ? new Date(user.last_login + "Z").toLocaleDateString()
                      : "never"}
                    {!user.has_password ? " · SSO only" : ""}
                    {user.identities.map((item) => ` · ${item.provider}:${item.subject}`).join("")}
                  </div>
                </div>
                {canManageUsers && (
                  <button
                    className="btn ghost sm"
                    title="Contact details"
                    disabled={!canManageUsers || protectedManageTarget}
                    onClick={() => (contactId === user.id ? setContactId(null) : openContact(user))}
                  >
                    <Mail size={13} />
                  </button>
                )}
                {canManageUsers && (
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={user.group_id ?? ""}
                    disabled={!canManageUsers || protectedManageTarget}
                    onChange={(e) =>
                      setGroup.mutate({ id: user.id, group_id: Number(e.target.value) })
                    }
                  >
                    {groups.map((g) => (
                      <option
                        key={g.id}
                        value={g.id}
                        disabled={Object.entries(g.effective).some(
                          ([permission, enabled]) =>
                            enabled && !me.user?.permissions[permission as Permission]
                        )}
                      >
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
                {canManageCredentials && !protectedAdmin && (
                  <>
                    <button
                      className="btn ghost sm"
                      title="Issue one-time password reset"
                      disabled={!!user.disabled || issueReset.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Issue a password reset and sign ${user.username} out everywhere?`
                          )
                        )
                          issueReset.mutate(user.id);
                      }}
                    >
                      <KeyRound size={13} />
                    </button>
                    <button
                      className="btn ghost sm"
                      title="Sign out all sessions"
                      disabled={logoutAll.isPending}
                      onClick={() => {
                        if (window.confirm(`Sign ${user.username} out everywhere?`))
                          logoutAll.mutate(user.id);
                      }}
                    >
                      <LogOut size={13} />
                    </button>
                  </>
                )}
                {me.user?.permissions.admin && (
                  <button
                    className="btn ghost sm"
                    title="Manage SSO identities"
                    onClick={() => setIdentityUserId(identityUserId === user.id ? null : user.id)}
                  >
                    <Link2 size={13} />
                  </button>
                )}
                {canManageUsers && !protectedManageTarget && !isSelf && (
                  <button
                    className="btn ghost sm"
                    title={user.disabled ? "Enable account" : "Disable account"}
                    disabled={setDisabled.isPending}
                    onClick={() => setDisabled.mutate({ id: user.id, disabled: !user.disabled })}
                  >
                    {user.disabled ? <Check size={13} /> : <Ban size={13} />}
                  </button>
                )}
                {canManageUsers && !protectedManageTarget && !isSelf && (
                  <button
                    className="btn ghost sm"
                    title="Delete account"
                    onClick={() => {
                      if (window.confirm(`Delete ${user.username}? This cannot be undone.`))
                        remove.mutate(user.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {contactId === user.id && (
                <div className="contact-editor">
                  <div className="form-grid">
                    <div className="field">
                      <label>Email</label>
                      <input
                        className="input"
                        type="email"
                        value={contact.email}
                        onChange={(e) => setContact({ ...contact, email: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>Phone</label>
                      <input
                        className="input"
                        value={contact.phone}
                        onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                      />
                    </div>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={contact.notify_email}
                      onChange={(e) => setContact({ ...contact, notify_email: e.target.checked })}
                    />
                    Email this member when Harbor raises a notification
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      className="btn primary sm"
                      disabled={saveContact.isPending}
                      onClick={() => saveContact.mutate({ id: user.id, ...contact })}
                    >
                      Save
                    </button>
                    <button className="btn ghost sm" onClick={() => setContactId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {identityUserId === user.id && me.user?.permissions.admin && (
                <div className="contact-editor">
                  <p className="sub">
                    Bind only the stable subject asserted by the configured identity provider.
                    Changing bindings signs this account out everywhere.
                  </p>
                  {user.identities.map((item) => (
                    <div className="row-item" key={item.id}>
                      <span className="grow">
                        {item.provider}:{item.subject}
                      </span>
                      <button
                        className="btn ghost sm"
                        title="Remove SSO identity"
                        disabled={unbindIdentity.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${item.provider}:${item.subject} from ${user.username}?`
                            )
                          )
                            unbindIdentity.mutate({ userId: user.id, identityId: item.id });
                        }}
                      >
                        <Unlink size={13} /> Remove
                      </button>
                    </div>
                  ))}
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <div className="field">
                      <label>Provider namespace</label>
                      <input
                        className="input"
                        maxLength={32}
                        value={identity.provider}
                        onChange={(event) =>
                          setIdentity({ ...identity, provider: event.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Stable subject</label>
                      <input
                        className="input"
                        maxLength={254}
                        value={identity.subject}
                        onChange={(event) =>
                          setIdentity({ ...identity, subject: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn primary sm"
                      disabled={!identity.provider || !identity.subject || bindIdentity.isPending}
                      onClick={() => bindIdentity.mutate(user.id)}
                    >
                      Bind identity
                    </button>
                    <button className="btn ghost sm" onClick={() => setIdentityUserId(null)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canManageUsers &&
        (!adding ? (
          <button className="btn primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            <Plus size={15} /> Add crew member
          </button>
        ) : (
          <form
            style={{ marginTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="form-grid">
              <div className="field">
                <label>Username</label>
                <input
                  className="input"
                  required
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Email (optional)</label>
                <input
                  className="input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              {canManageCredentials && (
                <div className="field">
                  <label>Password (blank = SSO-only account)</label>
                  <input
                    className="input"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
              )}
              <div className="field">
                <label>Group</label>
                <select
                  className="input"
                  value={form.group_id === "" ? (defaultGroupId ?? "") : form.group_id}
                  onChange={(e) => setForm({ ...form, group_id: Number(e.target.value) })}
                >
                  {groups.map((g) => (
                    <option
                      key={g.id}
                      value={g.id}
                      disabled={Object.entries(g.effective).some(
                        ([permission, enabled]) =>
                          enabled && !me.user?.permissions[permission as Permission]
                      )}
                    >
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" disabled={create.isPending || invite.isPending}>
                Add directly
              </button>
              <button
                type="button"
                className="btn"
                disabled={!form.username || create.isPending || invite.isPending}
                onClick={() => invite.mutate()}
              >
                Create invite
              </button>
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ))}
    </div>
  );
}
