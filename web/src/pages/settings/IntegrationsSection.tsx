import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import type { AdapterMeta, Integration } from "../../types";
import { tabIcons } from "../../components/Icon";
import GroupVisibility from "../../components/GroupVisibility";
import { useSession } from "../../App";
import { can } from "../../lib/perms";

interface FormState {
  type: string;
  name: string;
  url: string;
  public_url: string;
  secrets: Record<string, string>;
  use_downloads: boolean;
  use_calendar: boolean;
  use_status: boolean;
  enabled: boolean;
  berth: {
    enabled: boolean;
    icon: string;
    grp: string;
    sort: number;
    open_mode: "embed" | "new-tab";
    allowed_groups: number[];
  };
}

interface PlexPinState {
  id: number;
  expiresAt: string;
  status: string;
}

/** Preferred display order for catalog categories; unknowns fall to the end. */
const CATEGORY_ORDER = [
  "Media servers",
  "Media library",
  "Requests",
  "Indexers",
  "Download clients",
  "Books & audiobooks",
  "Monitoring",
  "Astrophotography",
  "Other",
];

/** Bucket the catalog by category, ordered by CATEGORY_ORDER then alphabetically. */
function groupByCategory(catalog: AdapterMeta[]): Array<[string, AdapterMeta[]]> {
  const groups = new Map<string, AdapterMeta[]>();
  for (const meta of catalog) {
    const cat = meta.category ?? "Other";
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(meta);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
}

function defaultBerthIcon(type: string): string {
  switch (type) {
    case "sonarr":
      return "tv";
    case "radarr":
      return "film";
    case "sabnzbd":
    case "qbittorrent":
      return "download";
    case "plex":
      return "play";
    default:
      return "globe";
  }
}

export default function IntegrationsSection() {
  const { me } = useSession();
  const canConfigure = can(me.user, "manageIntegrations");
  const canManageSecrets = can(me.user, "manageSecrets");
  const queryClient = useQueryClient();
  const { data: catalog = [] } = useQuery({
    queryKey: ["integrations", "catalog"],
    queryFn: () => api.get<AdapterMeta[]>("/api/integrations/catalog"),
  });
  const { data: integrations = [] } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<Integration[]>("/api/integrations"),
  });

  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [testResult, setTestResult] = useState<Record<number, string>>({});
  const [plexPin, setPlexPin] = useState<PlexPinState | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["integrations"] });
    queryClient.invalidateQueries({ queryKey: ["tabs"] });
    queryClient.invalidateQueries({ queryKey: ["widget"] });
    setEditing(null);
    setForm(null);
    setPlexPin(null);
  };

  const save = useMutation({
    mutationFn: () => {
      // only send secret fields the user actually typed (editing keeps stored ones)
      const secrets = Object.fromEntries(Object.entries(form!.secrets).filter(([, v]) => v !== ""));
      const body = canConfigure ? { ...form!, secrets } : { secrets };
      return editing === "new"
        ? api.post("/api/integrations", body)
        : api.patch(`/api/integrations/${editing}`, body);
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/integrations/${id}`),
    onSuccess: invalidate,
  });

  const test = useMutation({
    mutationFn: (id: number) =>
      api.post<{ ok: boolean; latencyMs: number; version?: string; message?: string }>(
        `/api/integrations/${id}/test`
      ),
    onSuccess: (result, id) => {
      setTestResult((prev) => ({
        ...prev,
        [id]: result.ok
          ? `✓ connected in ${result.latencyMs}ms${result.version ? ` · v${result.version}` : ""}`
          : `✗ ${result.message ?? "failed"}`,
      }));
    },
  });

  useEffect(() => {
    if (!plexPin || plexPin.id <= 0 || form?.type !== "plex") return;
    const timer = setInterval(async () => {
      try {
        const result = await api.get<{ authorized: boolean; token?: string }>(
          `/api/integrations/plex/pin/${plexPin.id}`
        );
        if (!result.authorized || !result.token) return;
        setForm((current) =>
          current?.type === "plex"
            ? {
                ...current,
                secrets: { ...current.secrets, token: result.token! },
              }
            : current
        );
        setPlexPin(null);
      } catch (err) {
        setPlexPin((current) =>
          current?.id === plexPin.id
            ? {
                ...current,
                id: 0,
                status: err instanceof Error ? err.message : "Plex sign-in failed",
              }
            : current
        );
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [plexPin, form?.type]);

  const startPlexLogin = async () => {
    const popup = window.open("about:blank", "harbor-plex-integration", "width=620,height=740");
    if (popup) popup.opener = null;
    try {
      const pin = await api.post<{ id: number; authUrl: string; expiresAt: string }>(
        "/api/integrations/plex/pin"
      );
      setPlexPin({ id: pin.id, expiresAt: pin.expiresAt, status: "Waiting for Plex approval..." });
      if (popup) popup.location.href = pin.authUrl;
      else window.open(pin.authUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      popup?.close();
      setPlexPin({
        id: 0,
        expiresAt: new Date().toISOString(),
        status: err instanceof Error ? err.message : "Could not start Plex sign-in",
      });
    }
  };

  const startNew = (meta: AdapterMeta) => {
    setEditing("new");
    setPlexPin(null);
    setForm({
      type: meta.type,
      name: meta.label,
      url: "",
      public_url: "",
      secrets: {},
      use_downloads: meta.capabilities.includes("queue"),
      use_calendar: meta.capabilities.includes("calendar"),
      use_status: true,
      enabled: true,
      berth: {
        enabled: false,
        icon: defaultBerthIcon(meta.type),
        grp: "",
        sort: 0,
        open_mode: "embed",
        allowed_groups: [],
      },
    });
  };

  const startEdit = (integration: Integration) => {
    setEditing(integration.id);
    setPlexPin(null);
    setForm({
      type: integration.type,
      name: integration.name,
      url: integration.url,
      public_url: integration.public_url,
      secrets: {},
      use_downloads: integration.use_downloads,
      use_calendar: integration.use_calendar,
      use_status: integration.use_status,
      enabled: integration.enabled,
      berth: { ...integration.berth, allowed_groups: integration.berth.allowed_groups ?? [] },
    });
  };

  const meta = form ? catalog.find((c) => c.type === form.type) : null;

  return (
    <>
      <div className="card">
        <h3>Connected integrations</h3>
        <div className="row-list">
          {integrations.map((integration) => (
            <div className="row-item" key={integration.id}>
              <Plug size={16} style={{ color: "var(--accent)" }} />
              <div className="grow">
                <div className="title">
                  {integration.name}{" "}
                  <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                    · {integration.label}
                  </span>
                </div>
                <div className="sub">
                  {integration.url}
                  {integration.public_url ? ` · public: ${integration.public_url}` : ""}
                  {integration.berth.enabled ? " · berthed" : ""}
                  {!integration.credentialsComplete ? " · credentials required" : ""}
                  {testResult[integration.id] ? ` — ${testResult[integration.id]}` : ""}
                </div>
              </div>
              {canConfigure && (
                <button
                  className="btn ghost sm"
                  disabled={test.isPending}
                  onClick={() => test.mutate(integration.id)}
                >
                  Test
                </button>
              )}
              <button className="btn ghost sm" onClick={() => startEdit(integration)}>
                <Pencil size={13} />
              </button>
              {canConfigure && (
                <button className="btn ghost sm" onClick={() => remove.mutate(integration.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          {integrations.length === 0 && (
            <div className="widget-empty">
              No integrations yet — connect Sonarr, Radarr, SABnzbd or qBittorrent below.
            </div>
          )}
        </div>
      </div>

      {editing !== null && form && meta ? (
        <div className="card">
          <h3>{editing === "new" ? `Connect ${meta.label}` : `Edit ${form.name}`}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="form-grid">
              <div className="field">
                <label>Display name</label>
                <input
                  className="input"
                  required
                  disabled={!canConfigure}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Internal URL</label>
                <input
                  className="input"
                  required
                  disabled={!canConfigure}
                  type="url"
                  value={form.url}
                  placeholder={meta.urlPlaceholder}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
                <span className="field-hint">
                  Where <em>Harbor's server</em> reaches the API. Must bypass SSO — use a Docker
                  service name or LAN IP (e.g. {meta.urlPlaceholder}), not your Google-OAuth public
                  URL. Changing the scheme, host, or port clears saved credentials unless you enter
                  replacements before saving.
                </span>
              </div>
              <div className="field full">
                <label>Public URL (optional)</label>
                <input
                  className="input"
                  type="url"
                  disabled={!canConfigure}
                  value={form.public_url}
                  placeholder="https://sonarr.example.com"
                  onChange={(e) => setForm({ ...form, public_url: e.target.value })}
                />
                <span className="field-hint">
                  Where <em>your browser</em> opens the app (deep-links &amp; embedded berth). This
                  is the SSO-protected public URL.
                </span>
              </div>
              {meta.fields.map((field) => (
                <div className="field" key={field.key}>
                  <label>
                    {field.label}
                    {editing !== "new" ? " (leave blank to keep saved value)" : ""}
                  </label>
                  <input
                    className="input"
                    type={field.type === "password" ? "password" : "text"}
                    required={field.required && editing === "new" && canManageSecrets}
                    disabled={!canManageSecrets}
                    value={form.secrets[field.key] ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        secrets: { ...form.secrets, [field.key]: e.target.value },
                      })
                    }
                  />
                  {form.type === "plex" && field.key === "token" && canManageSecrets && (
                    <div className="field-actions">
                      <button type="button" className="btn ghost sm" onClick={startPlexLogin}>
                        Sign in with Plex
                      </button>
                      <span className="sub">
                        {form.secrets.token
                          ? "Token ready"
                          : (plexPin?.status ?? "Authorize Harbor with your Plex account.")}
                      </span>
                    </div>
                  )}
                </div>
              ))}
              <div className="full">
                {canConfigure && meta.capabilities.includes("queue") && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.use_downloads}
                      onChange={(e) => setForm({ ...form, use_downloads: e.target.checked })}
                    />
                    Feed the Downloads widget
                  </label>
                )}
                {canConfigure && meta.capabilities.includes("calendar") && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.use_calendar}
                      onChange={(e) => setForm({ ...form, use_calendar: e.target.checked })}
                    />
                    Feed the Release calendar
                  </label>
                )}
                {canConfigure && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.use_status}
                      onChange={(e) => setForm({ ...form, use_status: e.target.checked })}
                    />
                    Watch in Fleet status
                  </label>
                )}
                {canConfigure && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.berth.enabled}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          berth: { ...form.berth, enabled: e.target.checked },
                        })
                      }
                    />
                    Berth this integration in the sidebar
                  </label>
                )}
                {canConfigure && form.berth.enabled && (
                  <div className="form-grid nested full">
                    <div className="field">
                      <label>Berth icon</label>
                      <select
                        className="input"
                        value={form.berth.icon}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            berth: { ...form.berth, icon: e.target.value },
                          })
                        }
                      >
                        {Object.keys(tabIcons).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>Sidebar group (optional)</label>
                      <input
                        className="input"
                        value={form.berth.grp}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            berth: { ...form.berth, grp: e.target.value },
                          })
                        }
                        placeholder="Media"
                      />
                    </div>
                    <div className="field">
                      <label>Sort order</label>
                      <input
                        className="input"
                        type="number"
                        value={form.berth.sort}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            berth: { ...form.berth, sort: Number(e.target.value) },
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Open mode</label>
                      <select
                        className="input"
                        value={form.berth.open_mode}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            berth: {
                              ...form.berth,
                              open_mode: e.target.value as FormState["berth"]["open_mode"],
                            },
                          })
                        }
                      >
                        <option value="embed">Embedded (iframe)</option>
                        <option value="new-tab">New browser tab</option>
                      </select>
                    </div>
                    <div className="field full">
                      <label>Visible to</label>
                      <GroupVisibility
                        value={form.berth.allowed_groups}
                        onChange={(allowed_groups) =>
                          setForm({ ...form, berth: { ...form.berth, allowed_groups } })
                        }
                      />
                    </div>
                    <p className="sub full" style={{ margin: 0, fontSize: 12.5 }}>
                      This creates a read-only Berths entry. Fleet status is still controlled by
                      this integration's Watch in Fleet status toggle to avoid duplicate services.
                    </p>
                  </div>
                )}
                {canConfigure && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn primary" disabled={save.isPending}>
                {editing === "new" ? "Connect" : "Save"}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="card">
          <h3>Add an integration</h3>
          {canConfigure &&
            groupByCategory(catalog).map(([category, metas]) => (
              <div className="catalog-group" key={category}>
                <div className="catalog-group-head">{category}</div>
                <div className="catalog-buttons">
                  {metas.map((c) => {
                    const count = integrations.filter((i) => i.type === c.type).length;
                    return (
                      <button key={c.type} className="btn" onClick={() => startNew(c)}>
                        <Plus size={14} /> {c.label}
                        {count > 0 && (
                          <span className="catalog-count" title={`${count} configured`}>
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
    </>
  );
}
