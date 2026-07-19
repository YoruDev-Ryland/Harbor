import { createContext, useContext, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import type { MeResponse } from "./types";
import { applyTheme } from "./theme/themes";
import { BrandMark } from "./components/Icon";
import Shell from "./components/Shell";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import ResetPassword from "./pages/ResetPassword";
import AcceptInvite from "./pages/AcceptInvite";

interface SessionCtx {
  me: MeResponse;
  refresh: () => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside provider");
  return ctx;
}

export default function App() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<MeResponse>("/api/auth/me"),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (me) {
      applyTheme(me.user?.theme || me.defaultTheme);
      document.title = me.title || "Harbor";
    }
  }, [me]);

  if (isLoading || !me) {
    return (
      <div className="splash">
        <BrandMark />
      </div>
    );
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["me"] });

  return (
    <Ctx.Provider value={{ me, refresh }}>
      {location.pathname === "/reset-password" ? (
        <ResetPassword />
      ) : location.pathname === "/accept-invite" ? (
        <AcceptInvite />
      ) : me.needsSetup ? (
        <Setup />
      ) : me.user ? (
        <Shell />
      ) : (
        <Login />
      )}
    </Ctx.Provider>
  );
}
