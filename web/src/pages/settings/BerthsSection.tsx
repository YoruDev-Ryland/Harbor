import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import { useSession } from "../../App";
import type { Tab } from "../../types";
import { TabIcon, tabIcons } from "../../components/Icon";
import GroupVisibility from "../../components/GroupVisibility";

interface TabForm {
  name: string;
  url: string;
  local_url: string;
  icon: string;
  grp: string;
  sort: number;
  open_mode: "embed" | "new-tab";
  ping: boolean;
  allowed_groups: number[];
}

const emptyForm: TabForm = {
  name: "",
  url: "",
  local_url: "",
  icon: "globe",
  grp: "",
  sort: 0,
  open_mode: "embed",
  ping: true,
  allowed_groups: [],
};

export default function BerthsSection() {
  const queryClient = useQueryClient();
  const { data: tabs = [] } = useQuery({
    queryKey: ["tabs"],
    queryFn: () => api.get<Tab[]>("/api/tabs"),
  });

  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<TabForm>(emptyForm);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["tabs"] });
    setEditing(null);
  };

  const save = useMutation({
    mutationFn: () =>
      editing === "new" ? api.post("/api/tabs", form) : api.patch(`/api/tabs/${editing}`, form),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/tabs/${id}`),
    onSuccess: invalidate,
  });

  const startEdit = (tab?: Tab) => {
    if (tab) {
      if (tab.integration_id) return;
      setEditing(tab.id);
      setForm({
        name: tab.name,
        url: tab.url,
        local_url: tab.local_url,
        icon: tab.icon,
        grp: tab.grp,
        sort: tab.sort,
        open_mode: tab.open_mode,
        ping: !!tab.ping,
        allowed_groups: tab.allowed_groups ?? [],
      });
    } else {
      setEditing("new");
      setForm(emptyForm);
    }
  };

  return (
    <>
      <GroupOrderCard tabs={tabs} />
      <div className="card">
        <h3>Berths — embedded services</h3>
        <div className="row-list">
          {tabs.map((tab) => (
            <div className={`row-item${tab.integration_id ? " managed" : ""}`} key={tab.id}>
              <TabIcon name={tab.icon} />
              <div className="grow">
                <div className="title">{tab.name}</div>
                <div className="sub">
                  {tab.url}
                  {tab.local_url ? ` · local: ${tab.local_url}` : ""}
                  {tab.grp ? ` · ${tab.grp}` : ""}
                  {tab.open_mode === "new-tab" ? " · opens in new tab" : ""}
                  {tab.integration_id ? " · managed from Integrations" : ""}
                </div>
              </div>
              {tab.integration_id ? (
                <span className="managed-note">Integration berth</span>
              ) : (
                <>
                  <button className="btn ghost sm" onClick={() => startEdit(tab)}>
                    <Pencil size={13} />
                  </button>
                  <button className="btn ghost sm" onClick={() => remove.mutate(tab.id)}>
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="widget-empty">No berths yet — moor your first service.</div>
          )}
        </div>

        {editing === null ? (
          <button className="btn primary" style={{ marginTop: 12 }} onClick={() => startEdit()}>
            <Plus size={15} /> Moor a service
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
                  placeholder="Plex"
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
                  placeholder="https://plex.example.com"
                />
              </div>
              <div className="field full">
                <label>Local URL (optional)</label>
                <input
                  className="input"
                  value={form.local_url}
                  onChange={(e) => setForm({ ...form, local_url: e.target.value })}
                  placeholder="http://192.168.1.20:32400"
                />
              </div>
              <div className="field">
                <label>Icon</label>
                <select
                  className="input"
                  value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })}
                >
                  {Object.keys(tabIcons).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Group (sidebar section, optional)</label>
                <input
                  className="input"
                  value={form.grp}
                  onChange={(e) => setForm({ ...form, grp: e.target.value })}
                  placeholder="Media"
                />
              </div>
              <div className="field">
                <label>Sort order</label>
                <input
                  className="input"
                  type="number"
                  value={form.sort}
                  onChange={(e) => setForm({ ...form, sort: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Open mode</label>
                <select
                  className="input"
                  value={form.open_mode}
                  onChange={(e) =>
                    setForm({ ...form, open_mode: e.target.value as TabForm["open_mode"] })
                  }
                >
                  <option value="embed">Embedded (iframe)</option>
                  <option value="new-tab">New browser tab</option>
                </select>
              </div>
              <label className="check-row full">
                <input
                  type="checkbox"
                  checked={form.ping}
                  onChange={(e) => setForm({ ...form, ping: e.target.checked })}
                />
                Watch in Fleet status
              </label>
              <div className="field full">
                <label>Visible to</label>
                <GroupVisibility
                  value={form.allowed_groups}
                  onChange={(allowed_groups) => setForm({ ...form, allowed_groups })}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn primary" disabled={save.isPending}>
                {editing === "new" ? "Add berth" : "Save"}
              </button>
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
            <p
              className="sub"
              style={{ marginTop: 10, fontSize: 12.5, color: "var(--text-faint)" }}
            >
              Embedding requires the target app to allow framing (no restrictive X-Frame-Options /
              frame-ancestors CSP). For apps behind the same Traefik + SSO, add a middleware that
              strips those headers if a berth renders blank. A local URL (e.g. a LAN IP) is used
              when you flip “Use local addresses” in the user menu — best for new-tab berths, since
              an http:// address can’t embed inside an https:// Harbor (mixed content).
            </p>
          </form>
        )}
      </div>
    </>
  );
}

/** Reorder how berth groups stack in the sidebar. Persists a settings key the
 *  session payload exposes as groupOrder; the sidebar sorts groups by it. */
function GroupOrderCard({ tabs }: { tabs: Tab[] }) {
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();

  const present = useMemo(() => {
    const set = new Set<string>();
    for (const t of tabs) set.add(t.grp || "");
    return set;
  }, [tabs]);

  const ordered = useMemo(() => {
    const saved = (() => {
      try {
        return me.groupOrder ? (JSON.parse(me.groupOrder) as string[]) : [];
      } catch {
        return [];
      }
    })();
    const result = saved.filter((g) => present.has(g));
    for (const g of present) if (!result.includes(g)) result.push(g);
    return result;
  }, [me.groupOrder, present]);

  const save = useMutation({
    mutationFn: (order: string[]) =>
      api.patch("/api/settings", { group_order: JSON.stringify(order) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      refresh();
    },
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[i], next[j]] = [next[j], next[i]];
    save.mutate(next);
  };

  if (ordered.length <= 1) return null;

  return (
    <div className="card">
      <h3>Sidebar group order</h3>
      <p className="sub" style={{ marginBottom: 12, fontSize: 12.5, color: "var(--text-faint)" }}>
        Arrange how berth groups stack in the sidebar.
      </p>
      <div className="row-list">
        {ordered.map((g, i) => (
          <div className="row-item" key={g || "__berths"}>
            <div className="grow">
              <div className="title">{g || "Berths"}</div>
            </div>
            <button
              className="btn ghost sm"
              disabled={i === 0 || save.isPending}
              onClick={() => move(i, -1)}
              title="Move up"
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="btn ghost sm"
              disabled={i === ordered.length - 1 || save.isPending}
              onClick={() => move(i, 1)}
              title="Move down"
            >
              <ArrowDown size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
