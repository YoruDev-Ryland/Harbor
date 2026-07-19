import { useState, type ComponentType } from "react";
import BerthsSection from "./settings/BerthsSection";
import IntegrationsSection from "./settings/IntegrationsSection";
import UsersSection from "./settings/UsersSection";
import GroupsSection from "./settings/GroupsSection";
import NotificationsSection from "./settings/NotificationsSection";
import SitesSection from "./settings/SitesSection";
import BackupSection from "./settings/BackupSection";
import AppearanceSection from "./settings/AppearanceSection";
import AuditSection from "./settings/AuditSection";
import { useSession } from "../App";
import { can } from "../lib/perms";
import type { Permission } from "../types";

const sections = [
  { id: "berths", name: "Berths", component: BerthsSection, perm: "manageBerths" },
  {
    id: "integrations",
    name: "Integrations",
    component: IntegrationsSection,
    perm: "manageIntegrations",
    altPerm: "manageSecrets",
  },
  { id: "sites", name: "Sites", component: SitesSection, perm: "manageMonitors" },
  {
    id: "users",
    name: "Crew",
    component: UsersSection,
    perm: "manageUsers",
    altPerm: "manageCredentials",
  },
  { id: "groups", name: "Groups", component: GroupsSection, perm: "admin" },
  {
    id: "notifications",
    name: "Notifications",
    component: NotificationsSection,
    perm: "manageNotifications",
    altPerm: "manageSecrets",
  },
  { id: "appearance", name: "Appearance", component: AppearanceSection, perm: "manageSettings" },
  { id: "backup", name: "Backup", component: BackupSection, perm: "admin" },
  { id: "audit", name: "Audit", component: AuditSection, perm: "admin" },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  component: ComponentType;
  perm: Permission;
  altPerm?: Permission;
}>;

export default function Settings() {
  const { me } = useSession();
  const visible = sections.filter(
    (s) => can(me.user, s.perm) || ("altPerm" in s && can(me.user, s.altPerm))
  );
  const [active, setActive] = useState<string>(visible[0]?.id ?? "");
  const current = visible.find((s) => s.id === active) ?? visible[0];
  if (!current) return null;
  const Section = current.component;

  return (
    <>
      <div className="overline">
        <span>Records office</span>
        <span className="overline-rule" aria-hidden />
      </div>
      <h1 className="page-title">Harbormaster</h1>
      <p className="page-sub">
        Berths, integrations, crew and the look of the place. Harbor {me.version} · schema{" "}
        {me.schemaVersion}
      </p>
      <div className="settings-tabs">
        {visible.map((s) => (
          <button
            key={s.id}
            className={`settings-tab${current.id === s.id ? " active" : ""}`}
            onClick={() => setActive(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <Section />
    </>
  );
}
