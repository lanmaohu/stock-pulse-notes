import {
  Activity, AlertTriangle, AtSign, CheckCircle2, Clock3, ExternalLink, History,
  KeyRound, Link2, LoaderCircle, LogIn, LogOut, Play, Plus, RefreshCw, Search, Settings,
  ShieldCheck, Trash2, UserRoundCheck, Users, Video, X
} from "lucide-react";
import { Fragment, lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type {
  CollectionRun, CollectionRunsResponse, CollectionSettings,
  CollectionSettingsResponse, Creator, CreatorCandidate, CreatorSearchResponse, CreatorsResponse,
  Platform, PlatformAccount, PlatformAccountsResponse, PlatformOAuthStartResponse, PlatformQrSession
} from "../shared/types";
import { useAdminAuth } from "./AdminAuth";
import { api } from "./api";
import { siteConfig } from "./siteConfig";
import { Avatar, EmptyState, FilingFooter, StatusDot, formatDate, formatNumber, platformLabel, runStatusLabel, triggerLabel } from "./ui";
import { adminNavigationItems, WorkspaceMobileNavigation, WorkspaceSidebar, type AdminTab } from "./WorkspaceNavigation";

const PortfolioView = lazy(() => import("./PortfolioView").then((module) => ({ default: module.PortfolioView })));

function usePageMetadata(title: string) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (meta) meta.content = "noindex,nofollow";
  }, [title]);
}

function Loading({ children }: { children: string }) {
  return <div className="route-loading"><LoaderCircle className="spin" size={24} />{children}</div>;
}

const platforms: Platform[] = ["bilibili", "douyin", "xiaohongshu", "twitter"];
const platformInput: Record<Platform, { hint: string; placeholder: string; idLabel: string }> = {
  bilibili: { hint: "支持主页链接、UID 或博主名称", placeholder: "例如：笨笨的韭菜 或 11473291", idLabel: "UID" },
  douyin: { hint: "支持主页链接、SEC_UID 或博主名称", placeholder: "粘贴抖音主页链接或输入博主名称", idLabel: "SEC_UID" },
  xiaohongshu: { hint: "支持主页链接、用户 ID 或博主名称", placeholder: "粘贴小红书主页链接或输入博主名称", idLabel: "用户 ID" },
  twitter: { hint: "支持 X/Twitter 主页链接、@用户名或账号名称", placeholder: "例如：@elonmusk 或粘贴 x.com 主页链接", idLabel: "账号 ID" }
};

function PlatformIcon({ platform }: { platform: Platform }) {
  if (platform === "douyin") return <Activity size={21} />;
  if (platform === "twitter") return <AtSign size={21} />;
  return <Video size={21} />;
}

function CreatorsView({ creators, connectedPlatforms, onChanged, onRun }: {
  creators: Creator[];
  connectedPlatforms: Set<Platform>;
  onChanged: () => Promise<void>;
  onRun: (creatorId: string) => Promise<void>;
}) {
  const [platform, setPlatform] = useState<Platform>(() => platforms.find((item) => connectedPlatforms.has(item)) || "bilibili");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CreatorCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const result = await api<CreatorSearchResponse>(`/api/creators/search?platform=${platform}&q=${encodeURIComponent(query.trim())}`);
      setCandidates(result.candidates);
      if (!result.candidates.length) setError(`没有找到匹配的${platformLabel[platform]}博主。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "博主搜索失败。");
    } finally {
      setSearching(false);
    }
  }

  function changePlatform(next: Platform) {
    setPlatform(next);
    setQuery("");
    setCandidates([]);
    setError("");
  }

  async function add(candidate: CreatorCandidate) {
    setAdding(candidate.externalId);
    setError("");
    try {
      await api("/api/creators", { method: "POST", body: JSON.stringify({ platform: candidate.platform, externalId: candidate.externalId }) });
      setCandidates([]);
      setQuery("");
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加博主失败。");
    } finally {
      setAdding("");
    }
  }

  async function toggle(creator: Creator) {
    await api(`/api/creators/${creator.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !creator.enabled }) });
    await onChanged();
  }

  return <div className="creator-layout">
    <section className="workspace-section add-creator">
      <div className="section-heading"><div><h2>添加博主</h2><p>{platformInput[platform].hint}</p></div><span className={`platform-badge ${platform}`}>{platformLabel[platform]}</span></div>
      <div className="platform-selector" role="group" aria-label="选择内容平台">{platforms.map((item) => <button type="button" key={item} className={item === platform ? "selected" : ""} onClick={() => changePlatform(item)}><span className={`platform-icon mini ${item}`}><PlatformIcon platform={item} /></span>{platformLabel[item]}{connectedPlatforms.has(item) ? <StatusDot status="good" /> : null}</button>)}</div>
      <form className="creator-search" onSubmit={search}><div className="search-field"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={platformInput[platform].placeholder} disabled={!connectedPlatforms.has(platform)} /></div><button className="primary-button compact" type="submit" disabled={!connectedPlatforms.has(platform) || searching || !query.trim()}>{searching ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}查找</button></form>
      {!connectedPlatforms.has(platform) ? <div className="inline-notice"><KeyRound size={17} />请先在“平台账号”中{platform === "twitter" ? "授权绑定" : "扫码绑定"}{platformLabel[platform]}账号。</div> : null}
      {error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}
      {candidates.length ? <div className="candidate-list">{candidates.map((candidate) => {
        const exists = creators.some((creator) => creator.platform === candidate.platform && creator.externalId === candidate.externalId);
        return <div className="candidate-row" key={`${candidate.platform}:${candidate.externalId}`}><Avatar src={candidate.avatarUrl} name={candidate.name} /><div><strong>{candidate.name}</strong><span>{candidate.handle || `${platformInput[candidate.platform].idLabel} ${candidate.externalId}`}{candidate.followerCount !== undefined ? ` · ${formatNumber(candidate.followerCount)} 粉丝` : ""}</span></div><a className="icon-button" href={candidate.profileUrl} target="_blank" rel="noreferrer" title="打开主页" aria-label="打开主页"><ExternalLink size={16} /></a><button className="secondary-button" onClick={() => void add(candidate)} disabled={exists || adding === candidate.externalId}>{adding === candidate.externalId ? <LoaderCircle className="spin" size={16} /> : exists ? <CheckCircle2 size={16} /> : <Plus size={16} />}{exists ? "已添加" : "添加"}</button></div>;
      })}</div> : null}
    </section>
    <section className="workspace-section">
      <div className="section-heading"><div><h2>已订阅博主</h2><p>{creators.filter((item) => item.enabled).length} 个正在监控</p></div></div>
      {creators.length ? <div className="creator-table">{creators.map((creator) => <div className={`creator-row ${creator.enabled ? "" : "disabled"}`} key={creator.id}><Avatar src={creator.avatarUrl} name={creator.name} /><div className="creator-identity"><strong>{creator.name}<span className={`platform-badge ${creator.platform}`}>{platformLabel[creator.platform]}</span></strong><span>{creator.handle || `${platformInput[creator.platform].idLabel} ${creator.externalId}`}</span></div><div className="creator-sync"><span><StatusDot status={creator.lastCollectionStatus === "error" ? "bad" : creator.lastCollectedAt ? "good" : "idle"} />{creator.lastCollectedAt ? formatDate(creator.lastCollectedAt) : "尚未采集"}</span>{creator.lastError ? <small title={creator.lastError}>{creator.lastError}</small> : null}</div><a className="icon-button" href={creator.profileUrl} target="_blank" rel="noreferrer" title="打开主页" aria-label="打开主页"><ExternalLink size={16} /></a><button className="icon-button" onClick={() => void onRun(creator.id)} disabled={!creator.enabled || !connectedPlatforms.has(creator.platform)} title="立即采集" aria-label="立即采集"><Play size={16} /></button><button className={`toggle ${creator.enabled ? "active" : ""}`} onClick={() => void toggle(creator)} role="switch" aria-checked={creator.enabled} title={creator.enabled ? "暂停监控" : "恢复监控"}><span /></button></div>)}</div> : <EmptyState icon={<Users size={25} />} title="还没有订阅博主" detail="绑定平台账号后，通过名称、账号 ID 或主页链接添加。" />}
    </section>
  </div>;
}

function QrDialog({ session, onClose }: { session: PlatformQrSession; onClose: () => void }) {
  const confirmed = session.status === "confirmed";
  const label = platformLabel[session.platform];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="qr-title"><div className="modal-header"><div><h2 id="qr-title">绑定{label}账号</h2><p>使用{label} App 扫码并确认</p></div><button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭"><X size={18} /></button></div><div className={`qr-stage ${session.status}`}>{session.qrImageDataUrl && !confirmed ? <img src={session.qrImageDataUrl} alt={`${label}登录二维码`} /> : null}{confirmed ? <CheckCircle2 size={58} /> : session.status === "expired" || session.status === "error" ? <AlertTriangle size={52} /> : null}</div><div className="qr-status">{session.status === "waiting" ? <><LoaderCircle className="spin" size={17} />等待扫码</> : null}{session.status === "scanned" ? <><UserRoundCheck size={17} />已扫码，请在手机确认</> : null}{session.status === "confirmed" ? <><CheckCircle2 size={17} />已绑定 {session.account?.displayName}</> : null}{session.status === "expired" ? <><Clock3 size={17} />二维码已过期</> : null}{session.status === "error" ? <><AlertTriangle size={17} />{session.error || "绑定失败"}</> : null}</div><button className="primary-button" onClick={onClose}>{confirmed ? "完成" : "关闭"}</button></section></div>;
}

function AccountsView({ accounts, onChanged }: { accounts: PlatformAccount[]; onChanged: () => Promise<void> }) {
  const [searchParams] = useSearchParams();
  const [qr, setQr] = useState<PlatformQrSession | null>(null);
  const [busyPlatform, setBusyPlatform] = useState<Platform | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Platform, string>>>({});
  useEffect(() => {
    if (searchParams.get("twitter") === "credits") {
      setErrors((current) => ({ ...current, twitter: "Twitter/X API 额度不足，请在 X Developer Console 充值后重新授权。" }));
    } else if (searchParams.get("twitter") === "error") {
      setErrors((current) => ({ ...current, twitter: "Twitter/X 授权失败或已取消，请重新授权。" }));
    }
  }, [searchParams]);
  useEffect(() => {
    if (!qr || (qr.status !== "waiting" && qr.status !== "scanned")) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<PlatformQrSession>(`/api/platform-accounts/${qr.platform}/qr/${qr.sessionId}`);
        setQr(next);
        if (next.status === "confirmed") await onChanged();
      } catch (caught) {
        setQr((current) => current ? { ...current, status: "error", error: caught instanceof Error ? caught.message : "绑定失败。" } : current);
      }
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [onChanged, qr]);
  async function connect(platform: Platform) { setBusyPlatform(platform); setErrors((current) => ({ ...current, [platform]: undefined })); try { if (platform === "twitter") { const result = await api<PlatformOAuthStartResponse>("/api/platform-accounts/twitter/oauth", { method: "POST" }); window.location.assign(result.authorizeUrl); return; } setQr(await api<PlatformQrSession>(`/api/platform-accounts/${platform}/qr`, { method: "POST" })); } catch (caught) { setErrors((current) => ({ ...current, [platform]: caught instanceof Error ? caught.message : platform === "twitter" ? "无法开始授权。" : "无法生成二维码。" })); } finally { setBusyPlatform(null); } }
  async function check(account: PlatformAccount) { setBusyPlatform(account.platform); setErrors((current) => ({ ...current, [account.platform]: undefined })); try { await api(`/api/platform-accounts/${account.id}/check`, { method: "POST" }); await onChanged(); } catch (caught) { setErrors((current) => ({ ...current, [account.platform]: caught instanceof Error ? caught.message : "账号检查失败。" })); await onChanged(); } finally { setBusyPlatform(null); } }
  async function disconnect(account: PlatformAccount) { if (!window.confirm(`解绑${platformLabel[account.platform]}账号？已采集内容和博主订阅不会删除。`)) return; await api(`/api/platform-accounts/${account.id}`, { method: "DELETE" }); await onChanged(); }
  async function closeQr() { const current = qr; setQr(null); if (current && (current.status === "waiting" || current.status === "scanned")) await api(`/api/platform-accounts/${current.platform}/qr/${current.sessionId}`, { method: "DELETE" }).catch(() => undefined); }
  return <section className="account-list">{platforms.map((platform) => {
    const account = accounts.find((item) => item.platform === platform);
    const busy = busyPlatform === platform;
    const status = account?.status === "connected" ? "已连接" : account?.status === "checking" ? "检查中" : account?.status === "needs_reauth" ? "需要重新登录" : account?.status === "error" ? "连接异常" : "未连接";
    return <Fragment key={platform}><div className="account-row available"><div className={`platform-icon ${platform}`}><PlatformIcon platform={platform} /></div>{account ? <Avatar src={account.avatarUrl} name={account.displayName} /> : <span className="account-avatar-spacer" />}<div className="account-name"><strong>{platformLabel[platform]}</strong><span>{account ? `${account.displayName} · ${platformInput[platform].idLabel} ${account.externalUserId}` : "未绑定"}</span></div><div className="account-status"><StatusDot status={account?.status === "connected" ? "good" : account ? "bad" : "idle"} /><span>{status}</span>{account?.lastCheckedAt ? <small>{formatDate(account.lastCheckedAt)}</small> : null}</div>{account ? <div className="row-actions"><button className="secondary-button" onClick={() => void check(account)} disabled={busy}><RefreshCw size={16} />检查</button><button className="secondary-button" onClick={() => void connect(platform)} disabled={busy}><Link2 size={16} />{platform === "twitter" ? "重新授权" : "重新绑定"}</button><button className="icon-button danger" onClick={() => void disconnect(account)} title="解绑账号" aria-label={`解绑${platformLabel[platform]}账号`}><Trash2 size={16} /></button></div> : <button className="primary-button compact" onClick={() => void connect(platform)} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}{platform === "twitter" ? "授权绑定" : "扫码绑定"}</button>}</div>{errors[platform] ? <div className="inline-error"><AlertTriangle size={17} />{errors[platform]}</div> : null}</Fragment>;
  })}{qr ? <QrDialog session={qr} onClose={() => void closeQr()} /> : null}</section>;
}

function RunsView({ runs, onRefresh }: { runs: CollectionRun[]; onRefresh: () => void }) {
  return runs.length ? <section className="run-list">{runs.map((run) => <article className="run-row" key={run.id}><div className={`run-icon ${run.status}`}>{run.status === "running" || run.status === "queued" ? <LoaderCircle className="spin" size={19} /> : run.status === "success" ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</div><div className="run-main"><div className="run-heading"><strong>{triggerLabel[run.trigger]}</strong><span className={`run-status ${run.status}`}>{runStatusLabel[run.status]}</span><time>{formatDate(run.createdAt)}</time></div><div className="run-metrics"><span>{run.creatorCount} 博主</span><span>{run.discoveredCount} 条发现</span><span>{run.newContentCount} 条新增</span><span>{run.analyzedCount} 条已分析</span>{run.errorCount ? <span className="error-count">{run.errorCount} 个问题</span> : null}</div>{run.error ? <div className="run-error">{run.error}</div> : null}{run.items.length ? <details><summary>查看博主明细</summary><div className="run-items">{run.items.map((item) => <div key={item.id}><strong>{item.creatorName}</strong><span>{item.status === "success" ? `发现 ${item.discoveredCount}，新增 ${item.newContentCount}，分析 ${item.analyzedCount}` : item.error || "等待处理"}</span></div>)}</div></details> : null}</div></article>)}<button className="floating-refresh icon-button" onClick={onRefresh} title="刷新任务" aria-label="刷新任务"><RefreshCw size={17} /></button></section> : <EmptyState icon={<History size={25} />} title="还没有采集记录" detail="新增博主或手动采集后，任务进度会显示在这里。" />;
}

function SettingsView({ settings, onSaved }: { settings: CollectionSettings; onSaved: (value: CollectionSettings) => void }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setSaved(false); setError("");
    try { const result = await api<CollectionSettingsResponse>("/api/collection-settings", { method: "PUT", body: JSON.stringify({ enabled: draft.enabled, localTime: draft.localTime, maxVideosPerCreator: draft.maxVideosPerCreator }) }); onSaved(result.settings); setSaved(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败。"); }
    finally { setBusy(false); }
  }
  return <form className="settings-form" onSubmit={save}><div className="setting-row"><div><strong>每日自动采集</strong><span>Asia/Shanghai</span></div><button type="button" className={`toggle ${draft.enabled ? "active" : ""}`} onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))} role="switch" aria-checked={draft.enabled}><span /></button></div><label className="setting-row" htmlFor="collection-time"><div><strong>执行时间</strong><span>服务重启错过时间后会自动补跑</span></div><input id="collection-time" type="time" value={draft.localTime} onChange={(event) => setDraft((current) => ({ ...current, localTime: event.target.value }))} /></label><label className="setting-row" htmlFor="video-limit"><div><strong>每个博主检查数量</strong><span>范围 1-20</span></div><input id="video-limit" type="number" min="1" max="20" value={draft.maxVideosPerCreator} onChange={(event) => setDraft((current) => ({ ...current, maxVideosPerCreator: Number(event.target.value) }))} /></label>{error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}<div className="form-actions"><button className="primary-button compact" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : saved ? <CheckCircle2 size={17} /> : <Settings size={17} />}{saved ? "已保存" : "保存设置"}</button></div></form>;
}

function AdminLoginPage() {
  const { authenticated, checking, login } = useAdminAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchParams] = useSearchParams();
  const requestedNext = searchParams.get("next");
  const next = requestedNext === "/portfolio" || requestedNext?.startsWith("/admin/") ? requestedNext : "/admin/creators";
  usePageMetadata(`${siteConfig.name}｜管理员登录`);
  if (checking) return <Loading>正在检查管理员会话</Loading>;
  if (authenticated) return <Navigate to={next} replace />;
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await login(password); } catch (caught) { setError(caught instanceof Error ? caught.message : "登录失败。"); } finally { setBusy(false); } }
  return <main className="admin-login-page"><form className="admin-login-dialog" onSubmit={submit}><Link className="icon-clear admin-login-close" to="/" aria-label="返回公开首页"><X size={18} /></Link><span className="admin-login-icon"><ShieldCheck size={24} /></span><h2>管理员登录</h2><p>登录后可管理博主、平台账号、采集任务、设置和持仓。</p><label><span>管理员密码</span><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入管理员密码" autoComplete="current-password" /></label>{error ? <div className="inline-error">{error}</div> : null}<button className="primary-button" type="submit" disabled={busy || !password}>{busy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录管理后台</button></form></main>;
}

function adminTab(pathname: string): AdminTab | null {
  const segment = pathname.split("/").filter(Boolean)[1];
  return adminNavigationItems.some((item) => item.adminTab === segment) ? segment as AdminTab : null;
}

function AdminWorkspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const { authenticated, checking, logout } = useAdminAuth();
  const tab = adminTab(location.pathname);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [runs, setRuns] = useState<CollectionRun[]>([]);
  const [settings, setSettings] = useState<CollectionSettings | null>(null);
  const [busyRun, setBusyRun] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const current = adminNavigationItems.find((item) => item.adminTab === tab);
  usePageMetadata(`${siteConfig.name}｜${current?.label || "管理后台"}`);
  const loadAccounts = useCallback(async () => setAccounts((await api<PlatformAccountsResponse>("/api/platform-accounts")).accounts), []);
  const loadCreators = useCallback(async () => setCreators((await api<CreatorsResponse>("/api/creators")).creators), []);
  const loadRuns = useCallback(async () => setRuns((await api<CollectionRunsResponse>("/api/collection-runs")).runs), []);
  useEffect(() => {
    if (!authenticated || !tab) return;
    let active = true; setLoading(true); setError("");
    const task = tab === "creators" ? Promise.all([loadCreators(), loadAccounts()]) : tab === "accounts" ? loadAccounts() : tab === "runs" ? loadRuns() : tab === "settings" ? api<CollectionSettingsResponse>("/api/collection-settings").then((result) => setSettings(result.settings)) : Promise.resolve();
    void task.catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "管理数据加载失败。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authenticated, loadAccounts, loadCreators, loadRuns, tab]);
  const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => { if (tab !== "runs" || !hasActiveRun) return; const timer = window.setInterval(() => void loadRuns(), 2500); return () => window.clearInterval(timer); }, [hasActiveRun, loadRuns, tab]);
  if (checking) return <Loading>正在检查管理员会话</Loading>;
  if (!authenticated) return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!tab) return <Navigate to="/admin/creators" replace />;
  const connectedPlatforms = new Set(accounts.filter((account) => account.status === "connected").map((account) => account.platform));
  const enabledCreators = creators.filter((creator) => creator.enabled);
  const collectibleCreators = enabledCreators.filter((creator) => connectedPlatforms.has(creator.platform));
  async function runNow(creatorId?: string) { setBusyRun(true); setError(""); try { await api<CollectionRun>("/api/collection-runs", { method: "POST", body: JSON.stringify(creatorId ? { creatorIds: [creatorId] } : {}) }); navigate("/admin/runs"); } catch (caught) { setError(caught instanceof Error ? caught.message : "无法开始采集。"); } finally { setBusyRun(false); } }
  async function signOut() {
    try {
      await logout();
      window.location.replace("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "退出失败。");
    }
  }
  return <main className="app-shell admin-shell"><WorkspaceSidebar hasActiveRun={hasActiveRun} onLogout={() => void signOut()} /><section className="main-column"><header className="page-header"><div><span className="eyebrow">Stockpulse Admin</span><h1>{current?.label}</h1></div><div className="header-actions">{tab === "creators" ? <button className="primary-button compact" onClick={() => void runNow()} disabled={busyRun || !collectibleCreators.length}>{busyRun ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}立即采集</button> : null}<button className="secondary-button admin-logout-button" onClick={() => void signOut()} aria-label="退出管理"><LogOut size={16} /><span>退出管理</span></button></div></header><WorkspaceMobileNavigation hasActiveRun={hasActiveRun} />{error ? <div className="global-error"><AlertTriangle size={18} /><span>{error}</span><button className="icon-clear" onClick={() => setError("")} aria-label="关闭"><X size={16} /></button></div> : null}{tab === "portfolio" ? <Suspense fallback={<Loading>正在加载持仓</Loading>}><PortfolioView adminMode /></Suspense> : <div className="page-content">{loading ? <div className="loading-line"><LoaderCircle className="spin" size={18} />正在加载管理数据</div> : null}{!loading && tab === "creators" ? <CreatorsView creators={creators} connectedPlatforms={connectedPlatforms} onChanged={async () => { await Promise.all([loadCreators(), loadAccounts()]); }} onRun={runNow} /> : null}{!loading && tab === "accounts" ? <AccountsView accounts={accounts} onChanged={loadAccounts} /> : null}{!loading && tab === "runs" ? <RunsView runs={runs} onRefresh={loadRuns} /> : null}{!loading && tab === "settings" && settings ? <SettingsView settings={settings} onSaved={setSettings} /> : null}</div>}<FilingFooter /></section></main>;
}

export default function AdminApp() {
  return <Routes><Route path="login" element={<AdminLoginPage />} /><Route path="*" element={<AdminWorkspace />} /></Routes>;
}
