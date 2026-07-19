import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Shield, Star, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Group, Permission, PermissionMeta } from "../../types";

interface GroupForm {
  name: string;
  permissions: Partial<Record<Permission, boolean>>;
  is_default: boolean;
}

const empty: GroupForm = { name: "", permissions: {}, is_default: false };

export default function GroupsSection() {
  const queryClient = useQueryClient();
  const { data: groups = [] } = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<Group[]>("/api/groups"),
  });
  const { data: perms = [] } = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api.get<PermissionMeta[]>("/api/permissions"),
  });

  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<GroupForm>(empty);
  const [error, setError] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["groups"] });
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["me"] });
    setEditing(null);
    setError("");
  };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "failed");

  const save = useMutation({
    mutationFn: () =>
      editing === "new" ? api.post("/api/groups", form) : api.patch(`/api/groups/${editing}`, form),
    onSuccess: invalidate,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/groups/${id}`),
    onSuccess: invalidate,
    onError: fail,
  });

  const startEdit = (g?: Group) => {
    setError("");
    if (g) {
      setEditing(g.id);
      setForm({ name: g.name, permissions: { ...g.permissions }, is_default: g.is_default });
    } else {
      setEditing("new");
      setForm(empty);
    }
  };

  const adminOn = !!form.permissions.admin;
  const togglePerm = (key: Permission, on: boolean) =>
    setForm((f) => ({ ...f, permissions: { ...f.permissions, [key]: on } }));

  return (
    <div className="card">
      <h3>Permission groups</h3>
      <p className="sub" style={{ color: "var(--text-faint)", fontSize: 13, marginTop: -6 }}>
        Each user belongs to one group. The default group is assigned to everyone who signs in
        through SSO for the first time.
      </p>
      {error && <div className="auth-error">{error}</div>}

      <div className="row-list">
        {groups.map((g) => (
          <div className="row-item" key={g.id}>
            <Shield size={17} className={g.effective.admin ? "nav-icon accent" : "nav-icon"} />
            <div className="grow">
              <div className="title">
                {g.name}
                {g.is_default && (
                  <span className="perm-badge default">
                    <Star size={11} /> default
                  </span>
                )}
              </div>
              <div className="sub">
                {g.memberCount} member{g.memberCount === 1 ? "" : "s"} ·{" "}
                {g.effective.admin
                  ? "full control"
                  : perms
                      .filter((p) => p.key !== "admin" && g.permissions[p.key])
                      .map((p) => p.label)
                      .join(", ") || "no permissions"}
              </div>
            </div>
            <button className="btn ghost sm" onClick={() => startEdit(g)}>
              <Pencil size={13} />
            </button>
            <button
              className="btn ghost sm"
              disabled={g.memberCount > 0 || g.is_default}
              title={
                g.memberCount > 0
                  ? "reassign members first"
                  : g.is_default
                    ? "set another default first"
                    : "delete group"
              }
              onClick={() => remove.mutate(g.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {editing === null ? (
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => startEdit()}>
          <Plus size={15} /> New group
        </button>
      ) : (
        <form
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Group name</label>
            <input
              className="input"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Guests"
            />
          </div>

          <div className="perm-list">
            {perms.map((p) => {
              const checked = p.key === "admin" ? adminOn : adminOn || !!form.permissions[p.key];
              return (
                <label className="perm-row" key={p.key}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={p.key !== "admin" && adminOn}
                    onChange={(e) => togglePerm(p.key, e.target.checked)}
                  />
                  <span>
                    <span className="perm-name">{p.label}</span>
                    <span className="perm-desc">{p.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <label className="check-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.is_default}
              onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
            />
            Default group for new SSO users
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={save.isPending}>
              <Check size={15} /> {editing === "new" ? "Create group" : "Save group"}
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
