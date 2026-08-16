import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthSessionResponse } from "../shared/types";
import { api, setUnauthorizedHandler } from "./api";

interface AdminAuthValue {
  authenticated: boolean;
  checking: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const session = await api<AuthSessionResponse>("/api/auth/session");
      setAuthenticated(session.authenticated);
    } catch {
      setAuthenticated(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => setUnauthorizedHandler(() => setAuthenticated(false)), []);

  const value = useMemo<AdminAuthValue>(() => ({
    authenticated,
    checking,
    refresh,
    async login(password) {
      await api<AuthSessionResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      setAuthenticated(true);
    },
    async logout() {
      await api<AuthSessionResponse>("/api/auth/logout", { method: "POST" });
      setAuthenticated(false);
    }
  }), [authenticated, checking, refresh]);

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error("useAdminAuth must be used inside AdminAuthProvider.");
  return value;
}
