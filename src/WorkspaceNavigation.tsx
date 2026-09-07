import {
  Activity,
  BriefcaseBusiness,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Settings,
  ShieldCheck,
  Users
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAdminAuth } from "./AdminAuth";
import { Brand } from "./ui";

export type AdminTab = "creators" | "accounts" | "runs" | "settings" | "portfolio";

type NavigationItem = {
  path: string;
  label: string;
  icon: ReactNode;
  adminTab?: AdminTab;
};

export const publicNavigationItems: NavigationItem[] = [
  { path: "/", label: "最新观点", icon: <Activity size={18} /> }
];

const administratorPageItems: NavigationItem[] = [
  { path: "/portfolio", label: "个人持仓", icon: <BriefcaseBusiness size={18} /> }
];

export const adminNavigationItems: NavigationItem[] = [
  { adminTab: "creators", path: "/admin/creators", label: "博主管理", icon: <Users size={18} /> },
  { adminTab: "accounts", path: "/admin/accounts", label: "平台账号", icon: <KeyRound size={18} /> },
  { adminTab: "runs", path: "/admin/runs", label: "采集记录", icon: <History size={18} /> },
  { adminTab: "settings", path: "/admin/settings", label: "采集设置", icon: <Settings size={18} /> },
  { adminTab: "portfolio", path: "/admin/portfolio", label: "持仓管理", icon: <BriefcaseBusiness size={18} /> }
];

function NavigationLinks({ authenticated, hasActiveRun = false }: { authenticated: boolean; hasActiveRun?: boolean }) {
  const items = authenticated ? [...publicNavigationItems, ...administratorPageItems, ...adminNavigationItems] : publicNavigationItems;
  return <>{items.map((item) => (
    <NavLink key={item.path} to={item.path} end={item.path === "/"}>
      {item.icon}
      <span>{item.label}</span>
      {item.adminTab === "runs" && hasActiveRun ? <i /> : null}
    </NavLink>
  ))}</>;
}

export function WorkspaceSidebar({ hasActiveRun = false, onLogout }: { hasActiveRun?: boolean; onLogout?: () => void }) {
  const { authenticated, checking, logout } = useAdminAuth();
  async function signOut() {
    if (onLogout) return onLogout();
    await logout();
    window.location.replace("/");
  }

  return <aside className="sidebar">
    <Brand />
    <span className="navigation-caption">工作空间</span>
    <nav aria-label="主导航"><NavigationLinks authenticated={authenticated} hasActiveRun={hasActiveRun} /></nav>
    <div className="sidebar-note"><Activity size={22} aria-hidden="true" /><p>看见不同观点。<br />形成自己的判断。</p><span>INFORMATION INTO PERSPECTIVE</span></div>
    <div className="sidebar-status">
      <div><ShieldCheck size={15} /><span>{checking ? "正在确认身份" : authenticated ? "管理员模式" : "公开浏览模式"}</span></div>
      {!checking && authenticated ? (
        <button className="sidebar-session-button" onClick={() => void signOut()}><LogOut size={15} />退出管理</button>
      ) : !checking ? (
        <Link className="sidebar-session-button" to="/admin/login"><LogIn size={15} />管理员登录</Link>
      ) : null}
    </div>
  </aside>;
}

export function WorkspaceMobileNavigation({ hasActiveRun = false }: { hasActiveRun?: boolean }) {
  const { authenticated } = useAdminAuth();
  return <nav className={`mobile-nav ${authenticated ? "authenticated" : "public"}`} aria-label="移动端主导航">
    <NavigationLinks authenticated={authenticated} hasActiveRun={hasActiveRun} />
  </nav>;
}
