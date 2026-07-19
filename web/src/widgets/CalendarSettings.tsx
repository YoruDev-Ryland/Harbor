import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Rss } from "lucide-react";
import { api } from "../api";
import { useSession } from "../App";
import {
  calCategories,
  calStatuses,
  clickActions,
  parseActions,
  readLegacyActions,
  useShowUnmonitored,
  type ActionMap,
  type CalCategory,
  type CalStatus,
  type ClickAction,
} from "../lib/calendarPrefs";

/**
 * The calendar's consolidated settings, shown inside a widget's edit-mode gear.
 * The click-action map is a shared default only admins may change; the
 * "include unmonitored" toggle and the iCal link are personal to each user.
 */
export default function CalendarSettings({ isAdmin }: { isAdmin: boolean }) {
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();
  const [showUnmonitored, setShowUnmonitored] = useShowUnmonitored();

  const [actions, setActions] = useState<ActionMap>(() => parseActions(me.calendarActions));
  useEffect(() => setActions(parseActions(me.calendarActions)), [me.calendarActions]);

  const saveActions = useMutation({
    mutationFn: (next: ActionMap) =>
      api.patch("/api/settings", { calendar_actions: JSON.stringify(next) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      refresh();
    },
  });

  // One-time lift of any pre-server (localStorage) click map into the shared
  // setting, so an admin's older choices aren't silently reset by the move.
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || !isAdmin || me.calendarActions) return;
    const legacy = readLegacyActions();
    if (!legacy) return;
    migrated.current = true;
    setActions(legacy);
    saveActions.mutate(legacy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, me.calendarActions]);

  const setCell = (cat: CalCategory, status: CalStatus, value: ClickAction) => {
    const next = { ...actions, [cat]: { ...actions[cat], [status]: value } };
    setActions(next);
    saveActions.mutate(next);
  };

  return (
    <>
      {isAdmin && (
        <div className="wset-block">
          <div className="wset-sep">Click opens… (shared default)</div>
          <table className="cal-prefs-table">
            <thead>
              <tr>
                <th />
                {calCategories.map((c) => (
                  <th key={c.id}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calStatuses.map((status) => (
                <tr key={status}>
                  <th>{status === "unaired" ? "upcoming" : status}</th>
                  {calCategories.map((c) => (
                    <td key={c.id}>
                      <select
                        className="edit-select"
                        value={actions[c.id][status]}
                        onChange={(e) => setCell(c.id, status, e.target.value as ClickAction)}
                      >
                        {clickActions.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="wset-savestate">
            {saveActions.isError ? (
              <span className="wset-saveerr">Couldn’t save — try again.</span>
            ) : saveActions.isPending ? (
              <span>Saving…</span>
            ) : saveActions.isSuccess ? (
              <span className="wset-saveok">
                <Check size={12} /> Saved for everyone
              </span>
            ) : (
              <span className="wset-savehint">Shared with all users · saves instantly</span>
            )}
          </div>
        </div>
      )}

      <div className="wset-sep">Your view</div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={showUnmonitored}
          onChange={(e) => setShowUnmonitored(e.target.checked)}
        />
        Include unmonitored releases
      </label>

      <IcalSubscribe />
    </>
  );
}

function IcalSubscribe() {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState<boolean | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ active: boolean; lastUsed: string | null }>("/api/calendar/subscribe")
      .then((status) => {
        setActive(status.active);
        setLastUsed(status.lastUsed);
      })
      .catch(() => undefined);
  }, []);
  const reveal = async () => {
    if (
      active &&
      !window.confirm("Create a new calendar URL? Your existing subscription will stop updating.")
    )
      return;
    const res = await api.post<{ url: string }>(
      active ? "/api/calendar/rotate" : "/api/calendar/subscribe"
    );
    setUrl(res.url);
    setActive(true);
    try {
      await navigator.clipboard.writeText(res.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; the field is selectable as a fallback */
    }
  };
  return (
    <div className="cal-subscribe">
      <button type="button" className="btn ghost sm" onClick={reveal}>
        <Rss size={13} /> {copied ? "Copied!" : active ? "Rotate iCal URL" : "Create iCal URL"}
      </button>
      {url && (
        <input
          className="input mono"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <p className="cal-subscribe-hint">
        {url
          ? "This URL is shown once. Add it to your calendar before closing this view."
          : active
            ? `A private subscription is active${lastUsed ? ` · last used ${new Date(lastUsed + "Z").toLocaleString()}` : ""}. Harbor stores only its digest.`
            : "Create a private URL, then add it as a subscribed calendar on your phone."}
      </p>
    </div>
  );
}
