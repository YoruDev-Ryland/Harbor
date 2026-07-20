import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  Home,
  LayoutDashboard,
  LogOut,
  Palette,
  Pencil,
  RotateCw,
  Settings as SettingsIcon,
  UserCog,
  Wifi,
} from "lucide-react";
import { api } from "../api";
import type { Tab } from "../types";
import { useSession } from "../App";
import { can, canManageAnything } from "../lib/perms";
import { applyTheme, themes } from "../theme/themes";
import { BrandMark, TabIcon } from "./Icon";
import CommandPalette, { type Command } from "./CommandPalette";
import NotificationBell from "./NotificationBell";
import AccountModal from "./AccountModal";
import Dashboard from "../pages/Dashboard";
import Settings from "../pages/Settings";

const COLLAPSE_KEY = "harbor.sidebar.collapsed";
const LOCAL_KEY = "harbor.useLocalAddresses";

function isPlexTab(tab: Tab): boolean {
  return `${tab.name} ${tab.url} ${tab.local_url} ${tab.icon}`.toLowerCase().includes("plex");
}

function plexWebRoot(url: string): string {
  const base = url.trim().replace(/\/+$/, "");
  const root = base.includes("/web") ? base.split("#")[0] : `${base}/web/index.html`;
  return root.endsWith("/web") ? `${root}/index.html` : root;
}

export default function Shell() {
  const { me, refresh } = useSession();
  const { data: tabs = [] } = useQuery({
    queryKey: ["tabs"],
    queryFn: () => api.get<Tab[]>("/api/tabs"),
  });

  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [useLocal, setUseLocal] = useState(() => localStorage.getItem(LOCAL_KEY) === "1");
  const [menuOpen, setMenuOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K toggles the command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem(LOCAL_KEY, useLocal ? "1" : "0");
  }, [useLocal]);

  // close the popout on outside click / escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const [openedIds, setOpenedIds] = useState<number[]>([]);
  const [reloadNonce, setReloadNonce] = useState<Record<number, number>>({});

  const location = useLocation();
  useEffect(() => {
    const match = location.pathname.match(/^\/tab\/(\d+)/);
    if (match) {
      const id = Number(match[1]);
      setOpenedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    }
  }, [location.pathname]);

  const groups = useMemo(() => {
    const map = new Map<string, Tab[]>();
    for (const tab of tabs) {
      const key = tab.grp || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(tab);
    }
    const entries = [...map.entries()];
    // honour the admin-defined group order; unlisted groups keep natural order after
    let order: string[] = [];
    try {
      order = me.groupOrder ? (JSON.parse(me.groupOrder) as string[]) : [];
    } catch {
      order = [];
    }
    if (order.length === 0) return entries;
    const rank = (name: string) => {
      const i = order.indexOf(name);
      return i === -1 ? order.length + 1 : i;
    };
    return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [tabs, me.groupOrder]);

  // running berth numbers across all groups, like a berth register
  const berthNo = useMemo(() => {
    const map = new Map<number, string>();
    let n = 0;
    for (const [, groupTabs] of groups)
      for (const tab of groupTabs) map.set(tab.id, String(++n).padStart(2, "0"));
    return map;
  }, [groups]);

  const resolveUrl = (tab: Tab) => {
    const url = useLocal && tab.local_url ? tab.local_url : tab.url;
    return isPlexTab(tab) ? plexWebRoot(url) : url;
  };

  const logout = async () => {
    await api.post("/api/auth/logout");
    refresh();
  };

  const anyLocal = tabs.some((t) => t.local_url);
  const showOverview = can(me.user, "viewOverview");

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (showOverview)
      list.push({
        id: "nav-overview",
        label: "Overview",
        section: "Go to",
        icon: <LayoutDashboard size={15} />,
        run: () => navigate("/"),
      });
    for (const tab of tabs)
      list.push({
        id: `tab-${tab.id}`,
        label: tab.name,
        section: tab.grp || "Berths",
        keywords: tab.grp,
        icon: <TabIcon name={tab.icon} size={15} />,
        run: () =>
          tab.open_mode === "new-tab"
            ? window.open(resolveUrl(tab), "_blank", "noopener,noreferrer")
            : navigate(`/tab/${tab.id}`),
      });
    if (canManageAnything(me.user))
      list.push({
        id: "nav-settings",
        label: "Harbormaster (settings)",
        section: "Go to",
        keywords: "admin settings config",
        icon: <SettingsIcon size={15} />,
        run: () => navigate("/settings"),
      });
    if (anyLocal)
      list.push({
        id: "toggle-local",
        label: `Use ${useLocal ? "public" : "local"} addresses`,
        section: "Action",
        icon: useLocal ? <Wifi size={15} /> : <Home size={15} />,
        run: () => setUseLocal((v) => !v),
      });
    for (const t of themes)
      list.push({
        id: `theme-${t.id}`,
        label: `Theme: ${t.name}`,
        section: "Theme",
        keywords: "appearance colour color",
        icon: <Palette size={15} />,
        run: () => {
          applyTheme(t.id);
          api
            .patch("/api/auth/prefs", { theme: t.id })
            .then(refresh)
            .catch(() => {});
        },
      });
    list.push({
      id: "signout",
      label: "Sign out",
      section: "Action",
      icon: <LogOut size={15} />,
      run: logout,
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, showOverview, anyLocal, useLocal, me.user]);

  return (
    <div className="shell">
      <aside className={`sidebar${collapsed ? " collapsed" : ""}${menuOpen ? " menu-open" : ""}`}>
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">{me.title || "Harbor"}</span>
            <span className="brand-sub">port authority</span>
          </div>
          <button
            className="sidebar-collapse"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>

        {showOverview && (
          <nav>
            <NavLink
              to="/"
              end
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <LayoutDashboard size={17} className="nav-icon" />
              <span>Overview</span>
            </NavLink>
          </nav>
        )}

        {groups.map(([groupName, groupTabs]) => (
          <div className="nav-section" key={groupName || "berths"}>
            <div className="nav-label">{groupName || "Berths"}</div>
            {groupTabs.map((tab) =>
              tab.open_mode === "new-tab" ? (
                <a
                  key={tab.id}
                  className="nav-item"
                  href={resolveUrl(tab)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={tab.name}
                >
                  <TabIcon name={tab.icon} />
                  <span>{tab.name}</span>
                  <span className="berth-no">{berthNo.get(tab.id)}</span>
                </a>
              ) : (
                <NavLink
                  key={tab.id}
                  to={`/tab/${tab.id}`}
                  title={tab.name}
                  className={({ isActive }) =>
                    `nav-item${isActive ? " active" : ""}${
                      openedIds.includes(tab.id) ? " loaded" : ""
                    }`
                  }
                >
                  <TabIcon name={tab.icon} />
                  <span>{tab.name}</span>
                  <span className="berth-no">{berthNo.get(tab.id)}</span>
                </NavLink>
              )
            )}
          </div>
        ))}

        <div className="nav-spacer" />

        <div className="sidebar-footer">
          <NotificationBell />
          <div className="user-menu-wrap" ref={menuRef}>
            {menuOpen && (
              <div className="user-menu" role="menu">
                <div className="user-menu-head">
                  <div className="avatar">{me.user!.username.slice(0, 1).toUpperCase()}</div>
                  <div className="user-menu-id">
                    <div className="user-menu-name">{me.user!.username}</div>
                    <div className="user-menu-role">{me.user!.role}</div>
                  </div>
                </div>

                <button
                  className="user-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setAccountOpen(true);
                  }}
                >
                  <UserCog size={16} /> Settings
                </button>

                {showOverview && (
                  <button
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/", { state: { editLayout: true } });
                    }}
                  >
                    <Pencil size={16} /> Edit dashboard layout
                  </button>
                )}

                {canManageAnything(me.user) && (
                  <NavLink
                    to="/settings"
                    className="user-menu-item"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                  >
                    <SettingsIcon size={16} /> Harbormaster
                  </NavLink>
                )}

                <button className="user-menu-item signout" role="menuitem" onClick={logout}>
                  <LogOut size={16} /> Sign out
                </button>
              </div>
            )}

            <button
              className={`user-chip${menuOpen ? " open" : ""}`}
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={me.user!.username}
            >
              <div className="avatar">{me.user!.username.slice(0, 1).toUpperCase()}</div>
              <span>{me.user!.username}</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route
            path="/"
            element={
              <div className="content" tabIndex={0}>
                {showOverview ? <Dashboard /> : <NoOverview hasTabs={tabs.length > 0} />}
              </div>
            }
          />
          <Route
            path="/settings/*"
            element={
              <div className="content" tabIndex={0}>
                {canManageAnything(me.user) ? <Settings /> : <NoAccess />}
              </div>
            }
          />
          <Route
            path="/tab/:id"
            element={
              <FrameBar
                tabs={tabs}
                resolveUrl={resolveUrl}
                onReload={(id) => setReloadNonce((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }))}
                onClose={(id) => {
                  setOpenedIds((ids) => ids.filter((openId) => openId !== id));
                  setReloadNonce((n) => {
                    const next = { ...n };
                    delete next[id];
                    return next;
                  });
                }}
              />
            }
          />
        </Routes>
        <Frames
          tabs={tabs}
          openedIds={openedIds}
          reloadNonce={reloadNonce}
          resolveUrl={resolveUrl}
          useLocal={useLocal}
        />
      </main>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} />
      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

function Frames({
  tabs,
  openedIds,
  reloadNonce,
  resolveUrl,
  useLocal,
}: {
  tabs: Tab[];
  openedIds: number[];
  reloadNonce: Record<number, number>;
  resolveUrl: (tab: Tab) => string;
  useLocal: boolean;
}) {
  const location = useLocation();
  const match = location.pathname.match(/^\/tab\/(\d+)/);
  const activeId = match ? Number(match[1]) : null;
  const state = location.state as { frameUrl?: string; frameNonce?: number } | null;
  const frameUrl = state?.frameUrl;
  const frameNonce = state?.frameNonce;

  const frameRefs = useRef<Record<number, HTMLIFrameElement | null>>({});
  // the src each mounted iframe was created with, frozen per mount key so a
  // later render can't swap it and force a reload
  const mountedSrc = useRef<Record<string, string>>({});
  // the last deep-link click (nonce) we've already applied to each frame
  const appliedNonce = useRef<Record<number, number | undefined>>({});

  // Deep-link into an ALREADY-open berth as a fragment navigation, never a
  // document reload — this is what keeps a Plex user/PIN session alive when
  // jumping between shows. The first open loads the deep link as the iframe's
  // src directly (see below), so this effect only fires for subsequent clicks.
  useEffect(() => {
    if (activeId == null || !frameUrl || frameNonce == null) return;
    if (appliedNonce.current[activeId] === frameNonce) return;
    const frame = frameRefs.current[activeId];
    if (!frame?.contentWindow) return;
    try {
      // replace() avoids piling up history entries inside the embedded app
      frame.contentWindow.location.replace(frameUrl);
    } catch {
      frame.contentWindow.location.href = frameUrl;
    }
    appliedNonce.current[activeId] = frameNonce;
  }, [activeId, frameUrl, frameNonce, openedIds]);

  return (
    <>
      {openedIds.map((id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return null;
        const active = activeId === id;
        // remount when local/remote toggles or on manual reload
        const frameKey = `${id}-${reloadNonce[id] ?? 0}-${useLocal ? "l" : "r"}`;
        if (mountedSrc.current[frameKey] === undefined) {
          // if this berth is being opened AT a deep link, load it there in one
          // shot instead of loading the app root then re-navigating (which
          // double-loads and can bounce Plex back to its login gate)
          const openingAtDeepLink = active && !!frameUrl && appliedNonce.current[id] === undefined;
          mountedSrc.current[frameKey] = openingAtDeepLink ? frameUrl! : resolveUrl(tab);
          if (openingAtDeepLink && frameNonce != null) appliedNonce.current[id] = frameNonce;
        }
        return (
          <div
            key={frameKey}
            className="frame-host"
            style={{ display: active ? "block" : "none", top: 37 }}
          >
            <iframe
              ref={(el) => {
                frameRefs.current[id] = el;
              }}
              src={mountedSrc.current[frameKey]}
              title={tab.name}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allow="fullscreen; autoplay"
            />
          </div>
        );
      })}
    </>
  );
}

function NoOverview({ hasTabs }: { hasTabs: boolean }) {
  return (
    <div className="access-empty">
      <h1 className="page-title">Welcome aboard</h1>
      <p className="page-sub">
        {hasTabs
          ? "Pick a berth from the sidebar to get started."
          : "Your account doesn’t have access to any berths yet. Ask an administrator to grant you access."}
      </p>
    </div>
  );
}

function NoAccess() {
  return (
    <div className="access-empty">
      <h1 className="page-title">Not your watch</h1>
      <p className="page-sub">You don’t have permission to manage this Harbor.</p>
    </div>
  );
}

function FrameBar({
  tabs,
  resolveUrl,
  onReload,
  onClose,
}: {
  tabs: Tab[];
  resolveUrl: (tab: Tab) => string;
  onReload: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const tab = tabs.find((t) => t.id === Number(id));
  if (!tab) return null;
  return (
    <div className="frame-bar">
      <TabIcon name={tab.icon} size={14} />
      <strong>{tab.name}</strong>
      <div className="grow" />
      <button className="btn ghost sm" title="Reload frame" onClick={() => onReload(tab.id)}>
        <RotateCw size={13} />
      </button>
      <button
        className="btn ghost sm"
        title="Open in new tab"
        onClick={() => window.open(resolveUrl(tab), "_blank", "noopener,noreferrer")}
      >
        <ExternalLink size={13} />
      </button>
      <button
        className="btn ghost sm"
        onClick={() => {
          onClose(tab.id);
          navigate("/");
        }}
      >
        Close
      </button>
    </div>
  );
}
