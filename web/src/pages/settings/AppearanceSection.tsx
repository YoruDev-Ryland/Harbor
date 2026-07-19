import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSession } from "../../App";
import { applyTheme, themes } from "../../theme/themes";

export default function AppearanceSection() {
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ title: string; default_theme: string }>("/api/settings"),
  });

  const [title, setTitle] = useState("");
  useEffect(() => {
    if (settings) setTitle(settings.title);
  }, [settings]);

  const saveTitle = useMutation({
    mutationFn: () => api.patch("/api/settings", { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      refresh();
    },
  });

  const setMyTheme = useMutation({
    mutationFn: (theme: string) => api.patch("/api/auth/prefs", { theme }),
    onSuccess: refresh,
  });

  const setDefaultTheme = useMutation({
    mutationFn: (theme: string) => api.patch("/api/settings", { default_theme: theme }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const currentTheme = me.user?.theme || "dockyard";

  return (
    <>
      <div className="card">
        <h3>Your theme</h3>
        <div className="theme-cards">
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={`theme-card${currentTheme === theme.id ? " selected" : ""}`}
              onClick={() => {
                applyTheme(theme.id);
                setMyTheme.mutate(theme.id);
              }}
            >
              <div className="swatches">
                {theme.swatches.map((color) => (
                  <span key={color} className="swatch" style={{ background: color }} />
                ))}
              </div>
              <div className="name">{theme.name}</div>
              <div className="desc">{theme.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Instance</h3>
        <div className="field" style={{ maxWidth: 360 }}>
          <label>Harbor name (sidebar + browser title)</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 360 }}>
          <label>Default theme for new users</label>
          <select
            className="input"
            value={settings?.default_theme ?? "dockyard"}
            onChange={(e) => setDefaultTheme.mutate(e.target.value)}
          >
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn primary"
          onClick={() => saveTitle.mutate()}
          disabled={saveTitle.isPending}
        >
          Save
        </button>
      </div>
    </>
  );
}
