import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Group } from "../types";

/**
 * Berth visibility picker. An empty selection means "everyone"; otherwise the
 * berth is only shown to members of the chosen groups (admins/berth-managers
 * always see every berth).
 */
export default function GroupVisibility({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const { data: groups = [] } = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<Group[]>("/api/groups"),
  });

  const everyone = value.length === 0;
  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((g) => g !== id) : [...value, id]);

  return (
    <div className="vis-picker">
      <button
        type="button"
        className={`filter-chip${everyone ? " on" : ""}`}
        onClick={() => onChange([])}
      >
        Everyone
      </button>
      {groups.map((g) => (
        <button
          type="button"
          key={g.id}
          className={`filter-chip${value.includes(g.id) ? " on" : ""}`}
          onClick={() => toggle(g.id)}
          title={g.effective.admin ? "admins already see every berth" : undefined}
        >
          {g.name}
        </button>
      ))}
    </div>
  );
}
