import { Activity } from "lucide-react";
import type { ReactNode } from "react";
import type { CollectionRun, Platform } from "../shared/types";
import { publicSecurityFilingUrl, siteConfig } from "./siteConfig";

export const platformLabel: Record<Platform, string> = {
  bilibili: "B站",
  douyin: "抖音",
  xiaohongshu: "小红书"
};

export const runStatusLabel: Record<CollectionRun["status"], string> = {
  queued: "等待中",
  running: "采集中",
  success: "已完成",
  partial: "部分完成",
  error: "失败"
};

export const triggerLabel: Record<CollectionRun["trigger"], string> = {
  manual: "手动采集",
  scheduled: "定时采集",
  subscription: "新增博主"
};

export function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatNumber(value?: number) {
  if (value === undefined) return "";
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(value);
}

export function Avatar({ src, name, size = "medium" }: { src?: string; name: string; size?: "small" | "medium" | "large" }) {
  return src ? (
    <img className={`avatar ${size}`} src={src} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className={`avatar avatar-fallback ${size}`}>{name.slice(0, 1).toUpperCase()}</span>
  );
}

export function StatusDot({ status }: { status: "good" | "warn" | "bad" | "idle" }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

export function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>;
}

export function Brand() {
  return <div className="brand"><div className="brand-mark small"><Activity size={20} /></div><div><strong>Stockpulse</strong><span>观点监控</span></div></div>;
}

export function FilingFooter() {
  const publicSecurity = siteConfig.publicSecurity;
  const showPublicSecurity = Boolean(publicSecurity.number && publicSecurity.recordCode && publicSecurity.iconPath);
  return (
    <footer className="filing-footer workspace-footer">
      <span className="filing-disclaimer">公开信息整理与学习参考，不构成任何投资建议</span>
      <span className="footer-divider" aria-hidden="true" />
      <span>© {new Date().getFullYear()} {siteConfig.name}</span>
      <span className="footer-divider" aria-hidden="true" />
      <a href={siteConfig.filing.icpUrl} target="_blank" rel="noreferrer">{siteConfig.filing.icpNumber}</a>
      {showPublicSecurity ? <>
        <span className="footer-divider" aria-hidden="true" />
        <a className="public-security-filing" href={publicSecurityFilingUrl(publicSecurity.recordCode)} target="_blank" rel="noreferrer">
          <img src={publicSecurity.iconPath} alt="" />{publicSecurity.number}
        </a>
      </> : null}
    </footer>
  );
}
