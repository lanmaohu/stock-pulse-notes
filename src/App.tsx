import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  Users,
  Video,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuthSessionResponse,
  BilibiliQrSession,
  CollectionRun,
  CollectionRunsResponse,
  CollectionSettings as CollectionSettingsType,
  CollectionSettingsResponse,
  ContentInsight,
  ContentInsightsResponse,
  Creator,
  CreatorCandidate,
  CreatorSearchResponse,
  CreatorsResponse,
  Platform,
  PlatformAccount,
  PlatformAccountsResponse,
  ViewConfidence,
  ViewStance
} from "../shared/types";

type AuthState = "loading" | "authenticated" | "anonymous";
type Tab = "insights" | "creators" | "accounts" | "runs" | "settings";

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error || "请求失败。", response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatNumber(value?: number) {
  if (value === undefined) return "";
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

const stanceLabel: Record<ViewStance, string> = {
  bullish: "看多",
  bearish: "看空",
  neutral: "中性",
  mixed: "分歧",
  watch: "观察"
};

const confidenceLabel: Record<ViewConfidence, string> = { high: "高置信", medium: "中置信", low: "低置信" };
const platformLabel: Record<Platform, string> = { bilibili: "B站", douyin: "抖音", xiaohongshu: "小红书" };
const runStatusLabel: Record<CollectionRun["status"], string> = {
  queued: "等待中",
  running: "采集中",
  success: "已完成",
  partial: "部分完成",
  error: "失败"
};
const triggerLabel: Record<CollectionRun["trigger"], string> = {
  manual: "手动采集",
  scheduled: "定时采集",
  subscription: "新增博主"
};

function Avatar({ src, name, size = "medium" }: { src?: string; name: string; size?: "small" | "medium" | "large" }) {
  return src ? (
    <img className={`avatar ${size}`} src={src} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className={`avatar avatar-fallback ${size}`}>{name.slice(0, 1).toUpperCase()}</span>
  );
}

function StatusDot({ status }: { status: "good" | "warn" | "bad" | "idle" }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api<AuthSessionResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onLogin();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark"><Activity size={25} /></div>
        <h1>Stockpulse</h1>
        <p>自媒体投资观点监控</p>
        <form onSubmit={submit}>
          <label htmlFor="password">访问密码</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入密码"
            autoFocus
          />
          {error ? <div className="field-error">{error}</div> : null}
          <button className="primary-button" type="submit" disabled={busy || !password}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />}
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

function InsightCard({ insight }: { insight: ContentInsight }) {
  const { content, views } = insight;
  return (
    <article className="insight-card">
      <div className="content-overview">
        {content.coverUrl ? (
          <a className="cover-link" href={content.sourceUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${content.title}`}>
            <img src={content.coverUrl} alt="" referrerPolicy="no-referrer" />
            <span><Play size={18} fill="currentColor" /></span>
          </a>
        ) : (
          <div className="cover-placeholder"><Video size={28} /></div>
        )}
        <div className="content-heading">
          <div className="content-kicker">
            <span className={`platform-badge ${content.platform}`}>{platformLabel[content.platform]}</span>
            <strong>{content.creatorName}</strong>
            <span>发布 {formatDate(content.publishedAt)}</span>
            <span>采集 {formatDate(content.collectedAt)}</span>
          </div>
          <a className="content-title" href={content.sourceUrl} target="_blank" rel="noreferrer">
            {content.title}<ExternalLink size={15} />
          </a>
          <div className="content-state">
            <span className={`analysis-state ${content.analysisStatus}`}>
              {content.analysisStatus === "success"
                ? "分析完成"
                : content.analysisStatus === "running"
                  ? "分析中"
                  : content.analysisStatus === "error"
                    ? "分析失败"
                    : "等待分析"}
            </span>
            <span>{content.transcriptSource === "subtitle" ? "字幕内容" : "字幕缺失 · 仅元数据"}</span>
          </div>
        </div>
      </div>

      {views.length ? (
        <div className="view-list">
          {views.map((view) => {
            const targets = [...view.symbols, ...view.companies];
            return (
              <section className="view-section" key={view.id}>
                <div className="view-title-row">
                  <div className="target-list">
                    {(targets.length ? targets : ["未识别具体标的"]).map((target) => <span key={target}>{target}</span>)}
                  </div>
                  <div className="view-flags">
                    <span className={`stance ${view.stance}`}>{stanceLabel[view.stance]}</span>
                    <span className={`confidence ${view.confidence}`}>{confidenceLabel[view.confidence]}</span>
                  </div>
                </div>
                <p className="core-view">{view.coreView}</p>
                <div className="evidence-grid">
                  <div>
                    <h3>依据</h3>
                    {view.evidence.length ? <ul>{view.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>暂无明确依据</p>}
                  </div>
                  <div>
                    <h3>风险</h3>
                    {view.risks.length ? <ul>{view.risks.map((item) => <li key={item}>{item}</li>)}</ul> : <p>暂无明确风险</p>}
                  </div>
                </div>
                {view.sourceSnippet ? <blockquote>{view.sourceSnippet}</blockquote> : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className={`analysis-message ${content.analysisStatus}`}>
          {content.analysisStatus === "error" ? <AlertTriangle size={17} /> : <LoaderCircle className={content.analysisStatus === "running" ? "spin" : ""} size={17} />}
          <span>{content.error || (content.analysisStatus === "success" ? "内容中没有识别到投资观点。" : "投资观点正在生成。")}</span>
        </div>
      )}
    </article>
  );
}

function InsightsView({
  insights,
  creators,
  date,
  query,
  creatorId,
  loading,
  onDate,
  onQuery,
  onCreator,
  onRefresh
}: {
  insights: ContentInsight[];
  creators: Creator[];
  date: string;
  query: string;
  creatorId: string;
  loading: boolean;
  onDate: (value: string) => void;
  onQuery: (value: string) => void;
  onCreator: (value: string) => void;
  onRefresh: () => void;
}) {
  const viewCount = insights.reduce((sum, item) => sum + item.views.length, 0);
  const targetCount = new Set(insights.flatMap((item) => item.views.flatMap((view) => [...view.symbols, ...view.companies]))).size;
  return (
    <>
      <section className="metric-row">
        <div><span>内容</span><strong>{insights.length}</strong></div>
        <div><span>观点</span><strong>{viewCount}</strong></div>
        <div><span>涉及标的</span><strong>{targetCount}</strong></div>
      </section>
      <section className="filter-bar">
        <div className="date-filter">
          <CalendarDays size={17} />
          <input type="date" value={date} onChange={(event) => onDate(event.target.value)} aria-label="采集日期" />
          <button className={!date ? "selected" : ""} onClick={() => onDate("")}>全部</button>
          <button className={date === todayShanghai() ? "selected" : ""} onClick={() => onDate(todayShanghai())}>今天</button>
        </div>
        <div className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索标题、博主、标的或观点" />
          {query ? <button className="icon-clear" onClick={() => onQuery("")} title="清空搜索" aria-label="清空搜索"><X size={15} /></button> : null}
        </div>
        <select value={creatorId} onChange={(event) => onCreator(event.target.value)} aria-label="筛选博主">
          <option value="">全部博主</option>
          {creators.map((creator) => <option key={creator.id} value={creator.id}>{creator.name}</option>)}
        </select>
        <button className="icon-button" onClick={onRefresh} title="刷新观点" aria-label="刷新观点"><RefreshCw size={17} /></button>
      </section>
      {loading ? (
        <div className="loading-line"><LoaderCircle className="spin" size={18} />正在加载观点</div>
      ) : insights.length ? (
        <section className="insight-list">{insights.map((insight) => <InsightCard key={insight.content.id} insight={insight} />)}</section>
      ) : (
        <EmptyState icon={<Activity size={26} />} title="没有匹配的观点" detail={date ? "当天没有新采集内容，可以查看全部日期或开始一次采集。" : "添加博主并完成首次采集后，观点会显示在这里。"} />
      )}
    </>
  );
}

function CreatorsView({
  creators,
  accountConnected,
  onChanged,
  onRun
}: {
  creators: Creator[];
  accountConnected: boolean;
  onChanged: () => Promise<void>;
  onRun: (creatorId: string) => Promise<void>;
}) {
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
      const result = await api<CreatorSearchResponse>(`/api/creators/search?platform=bilibili&q=${encodeURIComponent(query.trim())}`);
      setCandidates(result.candidates);
      if (!result.candidates.length) setError("没有找到匹配的 B 站博主。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "博主搜索失败。");
    } finally {
      setSearching(false);
    }
  }

  async function add(candidate: CreatorCandidate) {
    setAdding(candidate.externalId);
    setError("");
    try {
      await api("/api/creators", {
        method: "POST",
        body: JSON.stringify({ platform: candidate.platform, externalId: candidate.externalId })
      });
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

  return (
    <div className="creator-layout">
      <section className="workspace-section add-creator">
        <div className="section-heading"><div><h2>添加 B 站博主</h2><p>支持主页链接、UID 或博主名称</p></div><span className="platform-badge bilibili">B站</span></div>
        <form className="creator-search" onSubmit={search}>
          <div className="search-field">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：笨笨的韭菜 或 11473291" disabled={!accountConnected} />
          </div>
          <button className="primary-button compact" type="submit" disabled={!accountConnected || searching || !query.trim()}>
            {searching ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}查找
          </button>
        </form>
        {!accountConnected ? <div className="inline-notice"><KeyRound size={17} />请先在“平台账号”中扫码绑定 B 站账号。</div> : null}
        {error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}
        {candidates.length ? (
          <div className="candidate-list">
            {candidates.map((candidate) => {
              const exists = creators.some((creator) => creator.platform === candidate.platform && creator.externalId === candidate.externalId);
              return (
                <div className="candidate-row" key={candidate.externalId}>
                  <Avatar src={candidate.avatarUrl} name={candidate.name} />
                  <div><strong>{candidate.name}</strong><span>UID {candidate.externalId}{candidate.followerCount !== undefined ? ` · ${formatNumber(candidate.followerCount)} 粉丝` : ""}</span></div>
                  <a className="icon-button" href={candidate.profileUrl} target="_blank" rel="noreferrer" title="打开主页" aria-label="打开主页"><ExternalLink size={16} /></a>
                  <button className="secondary-button" onClick={() => void add(candidate)} disabled={exists || adding === candidate.externalId}>
                    {adding === candidate.externalId ? <LoaderCircle className="spin" size={16} /> : exists ? <CheckCircle2 size={16} /> : <Plus size={16} />}
                    {exists ? "已添加" : "添加"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="workspace-section">
        <div className="section-heading"><div><h2>已订阅博主</h2><p>{creators.filter((item) => item.enabled).length} 个正在监控</p></div></div>
        {creators.length ? (
          <div className="creator-table">
            {creators.map((creator) => (
              <div className={`creator-row ${creator.enabled ? "" : "disabled"}`} key={creator.id}>
                <Avatar src={creator.avatarUrl} name={creator.name} />
                <div className="creator-identity"><strong>{creator.name}</strong><span>UID {creator.externalId}</span></div>
                <div className="creator-sync">
                  <span><StatusDot status={creator.lastCollectionStatus === "error" ? "bad" : creator.lastCollectedAt ? "good" : "idle"} />{creator.lastCollectedAt ? formatDate(creator.lastCollectedAt) : "尚未采集"}</span>
                  {creator.lastError ? <small title={creator.lastError}>{creator.lastError}</small> : null}
                </div>
                <a className="icon-button" href={creator.profileUrl} target="_blank" rel="noreferrer" title="打开主页" aria-label="打开主页"><ExternalLink size={16} /></a>
                <button className="icon-button" onClick={() => void onRun(creator.id)} disabled={!creator.enabled || !accountConnected} title="立即采集" aria-label="立即采集"><Play size={16} /></button>
                <button className={`toggle ${creator.enabled ? "active" : ""}`} onClick={() => void toggle(creator)} role="switch" aria-checked={creator.enabled} title={creator.enabled ? "暂停监控" : "恢复监控"}>
                  <span />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Users size={25} />} title="还没有订阅博主" detail="绑定 B 站账号后，通过名称、UID 或主页链接添加。" />
        )}
      </section>
    </div>
  );
}

function QrDialog({ session, onClose }: { session: BilibiliQrSession; onClose: () => void }) {
  const confirmed = session.status === "confirmed";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="qr-title">
        <div className="modal-header"><div><h2 id="qr-title">绑定 B 站账号</h2><p>使用 B 站 App 扫码并确认</p></div><button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭"><X size={18} /></button></div>
        <div className={`qr-stage ${session.status}`}>
          {session.qrImageDataUrl && !confirmed ? <img src={session.qrImageDataUrl} alt="B 站登录二维码" /> : null}
          {confirmed ? <CheckCircle2 size={58} /> : session.status === "expired" || session.status === "error" ? <AlertTriangle size={52} /> : null}
        </div>
        <div className="qr-status">
          {session.status === "waiting" ? <><LoaderCircle className="spin" size={17} />等待扫码</> : null}
          {session.status === "scanned" ? <><UserRoundCheck size={17} />已扫码，请在手机确认</> : null}
          {session.status === "confirmed" ? <><CheckCircle2 size={17} />已绑定 {session.account?.displayName}</> : null}
          {session.status === "expired" ? <><Clock3 size={17} />二维码已过期</> : null}
          {session.status === "error" ? <><AlertTriangle size={17} />{session.error || "绑定失败"}</> : null}
        </div>
        <button className="primary-button" onClick={onClose}>{confirmed ? "完成" : "关闭"}</button>
      </section>
    </div>
  );
}

function AccountsView({ accounts, onChanged }: { accounts: PlatformAccount[]; onChanged: () => Promise<void> }) {
  const bilibili = accounts.find((account) => account.platform === "bilibili");
  const [qr, setQr] = useState<BilibiliQrSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!qr || (qr.status !== "waiting" && qr.status !== "scanned")) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<BilibiliQrSession>(`/api/platform-accounts/bilibili/qr/${qr.sessionId}`);
        setQr(next);
        if (next.status === "confirmed") await onChanged();
      } catch (caught) {
        setQr((current) => current ? { ...current, status: "error", error: caught instanceof Error ? caught.message : "绑定失败。" } : current);
      }
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [onChanged, qr]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      setQr(await api<BilibiliQrSession>("/api/platform-accounts/bilibili/qr", { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法生成二维码。");
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!bilibili) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/platform-accounts/${bilibili.id}/check`, { method: "POST" });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号检查失败。");
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!bilibili || !window.confirm("解绑 B 站账号？已采集内容和博主订阅不会删除。")) return;
    await api(`/api/platform-accounts/${bilibili.id}`, { method: "DELETE" });
    await onChanged();
  }

  return (
    <section className="account-list">
      <div className="account-row available">
        <div className="platform-icon bilibili"><Video size={21} /></div>
        {bilibili ? <Avatar src={bilibili.avatarUrl} name={bilibili.displayName} /> : null}
        <div className="account-name"><strong>B 站</strong><span>{bilibili ? `${bilibili.displayName} · UID ${bilibili.externalUserId}` : "未绑定"}</span></div>
        <div className="account-status">
          <StatusDot status={bilibili?.status === "connected" ? "good" : bilibili ? "bad" : "idle"} />
          <span>{bilibili?.status === "connected" ? "已连接" : bilibili?.status === "checking" ? "检查中" : bilibili?.status === "needs_reauth" ? "需要重新登录" : bilibili?.status === "error" ? "连接异常" : "未连接"}</span>
          {bilibili?.lastCheckedAt ? <small>{formatDate(bilibili.lastCheckedAt)}</small> : null}
        </div>
        {bilibili ? (
          <div className="row-actions">
            <button className="secondary-button" onClick={() => void check()} disabled={busy}><RefreshCw size={16} />检查</button>
            <button className="secondary-button" onClick={() => void connect()} disabled={busy}><Link2 size={16} />重新绑定</button>
            <button className="icon-button danger" onClick={() => void disconnect()} title="解绑账号" aria-label="解绑账号"><Trash2 size={16} /></button>
          </div>
        ) : (
          <button className="primary-button compact" onClick={() => void connect()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}扫码绑定</button>
        )}
      </div>
      {error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}
      {(["douyin", "xiaohongshu"] as Platform[]).map((platform) => (
        <div className="account-row unavailable" key={platform}>
          <div className={`platform-icon ${platform}`}>{platform === "douyin" ? <Activity size={21} /> : <Video size={21} />}</div>
          <div className="account-name"><strong>{platform === "douyin" ? "抖音" : "小红书"}</strong><span>数据源待接入</span></div>
          <span className="roadmap-badge">后续版本</span>
        </div>
      ))}
      {qr ? <QrDialog session={qr} onClose={() => setQr(null)} /> : null}
    </section>
  );
}

function RunsView({ runs, onRefresh }: { runs: CollectionRun[]; onRefresh: () => void }) {
  return runs.length ? (
    <section className="run-list">
      {runs.map((run) => (
        <article className="run-row" key={run.id}>
          <div className={`run-icon ${run.status}`}>
            {run.status === "running" || run.status === "queued" ? <LoaderCircle className="spin" size={19} /> : run.status === "success" ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
          </div>
          <div className="run-main">
            <div className="run-heading"><strong>{triggerLabel[run.trigger]}</strong><span className={`run-status ${run.status}`}>{runStatusLabel[run.status]}</span><time>{formatDate(run.createdAt)}</time></div>
            <div className="run-metrics">
              <span>{run.creatorCount} 博主</span><span>{run.discoveredCount} 条发现</span><span>{run.newContentCount} 条新增</span><span>{run.analyzedCount} 条已分析</span>{run.errorCount ? <span className="error-count">{run.errorCount} 个问题</span> : null}
            </div>
            {run.error ? <div className="run-error">{run.error}</div> : null}
            {run.items.length ? (
              <details>
                <summary>查看博主明细</summary>
                <div className="run-items">
                  {run.items.map((item) => (
                    <div key={item.id}><strong>{item.creatorName}</strong><span>{item.status === "success" ? `发现 ${item.discoveredCount}，新增 ${item.newContentCount}，分析 ${item.analyzedCount}` : item.error || "等待处理"}</span></div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </article>
      ))}
      <button className="floating-refresh icon-button" onClick={onRefresh} title="刷新任务" aria-label="刷新任务"><RefreshCw size={17} /></button>
    </section>
  ) : (
    <EmptyState icon={<History size={25} />} title="还没有采集记录" detail="新增博主或手动采集后，任务进度会显示在这里。" />
  );
}

function SettingsView({ settings, onSaved }: { settings: CollectionSettingsType; onSaved: (value: CollectionSettingsType) => void }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDraft(settings), [settings]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const result = await api<CollectionSettingsResponse>("/api/collection-settings", {
        method: "PUT",
        body: JSON.stringify({ enabled: draft.enabled, localTime: draft.localTime, maxVideosPerCreator: draft.maxVideosPerCreator })
      });
      onSaved(result.settings);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <div className="setting-row">
        <div><strong>每日自动采集</strong><span>Asia/Shanghai</span></div>
        <button type="button" className={`toggle ${draft.enabled ? "active" : ""}`} onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))} role="switch" aria-checked={draft.enabled}><span /></button>
      </div>
      <label className="setting-row" htmlFor="collection-time">
        <div><strong>执行时间</strong><span>服务重启错过时间后会自动补跑</span></div>
        <input id="collection-time" type="time" value={draft.localTime} onChange={(event) => setDraft((current) => ({ ...current, localTime: event.target.value }))} />
      </label>
      <label className="setting-row" htmlFor="video-limit">
        <div><strong>每个博主检查数量</strong><span>范围 1-20</span></div>
        <input id="video-limit" type="number" min="1" max="20" value={draft.maxVideosPerCreator} onChange={(event) => setDraft((current) => ({ ...current, maxVideosPerCreator: Number(event.target.value) }))} />
      </label>
      {error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}
      <div className="form-actions"><button className="primary-button compact" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : saved ? <CheckCircle2 size={17} /> : <Settings size={17} />}{saved ? "已保存" : "保存设置"}</button></div>
    </form>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [tab, setTab] = useState<Tab>("insights");
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [insights, setInsights] = useState<ContentInsight[]>([]);
  const [runs, setRuns] = useState<CollectionRun[]>([]);
  const [settings, setSettings] = useState<CollectionSettingsType | null>(null);
  const [insightDate, setInsightDate] = useState(todayShanghai());
  const [insightQuery, setInsightQuery] = useState("");
  const [creatorFilter, setCreatorFilter] = useState("");
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [busyRun, setBusyRun] = useState(false);
  const [error, setError] = useState("");

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      setAuth("anonymous");
      return;
    }
    setError(caught instanceof Error ? caught.message : "操作失败。");
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      const [accountData, creatorData, runData, settingData] = await Promise.all([
        api<PlatformAccountsResponse>("/api/platform-accounts"),
        api<CreatorsResponse>("/api/creators"),
        api<CollectionRunsResponse>("/api/collection-runs"),
        api<CollectionSettingsResponse>("/api/collection-settings")
      ]);
      setAccounts(accountData.accounts);
      setCreators(creatorData.creators);
      setRuns(runData.runs);
      setSettings(settingData.settings);
      setError("");
    } catch (caught) {
      handleError(caught);
    }
  }, [handleError]);

  const loadInsights = useCallback(async () => {
    if (auth !== "authenticated") return;
    setLoadingInsights(true);
    try {
      const params = new URLSearchParams();
      if (insightDate) params.set("collectedDate", insightDate);
      if (insightQuery.trim()) params.set("q", insightQuery.trim());
      if (creatorFilter) params.set("creatorId", creatorFilter);
      const result = await api<ContentInsightsResponse>(`/api/content-insights?${params.toString()}`);
      setInsights(result.insights);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoadingInsights(false);
    }
  }, [auth, creatorFilter, handleError, insightDate, insightQuery]);

  useEffect(() => {
    void api<AuthSessionResponse>("/api/auth/session")
      .then(() => setAuth("authenticated"))
      .catch(() => setAuth("anonymous"));
  }, []);

  useEffect(() => {
    if (auth === "authenticated") void loadWorkspace();
  }, [auth, loadWorkspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadInsights(), insightQuery ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [loadInsights, insightQuery]);

  const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => {
    if (!hasActiveRun || auth !== "authenticated") return;
    const timer = window.setInterval(async () => {
      await loadWorkspace();
      await loadInsights();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [auth, hasActiveRun, loadInsights, loadWorkspace]);

  const bilibiliConnected = accounts.some((account) => account.platform === "bilibili" && account.status === "connected");
  const enabledCreators = useMemo(() => creators.filter((creator) => creator.enabled), [creators]);

  async function runNow(creatorId?: string) {
    setBusyRun(true);
    setError("");
    try {
      await api<CollectionRun>("/api/collection-runs", {
        method: "POST",
        body: JSON.stringify(creatorId ? { creatorIds: [creatorId] } : {})
      });
      setTab("runs");
      await loadWorkspace();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusyRun(false);
    }
  }

  async function logout() {
    await api<AuthSessionResponse>("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuth("anonymous");
  }

  if (auth === "loading") return <main className="boot-screen"><LoaderCircle className="spin" size={28} /><span>正在打开 Stockpulse</span></main>;
  if (auth === "anonymous") return <Login onLogin={() => setAuth("authenticated")} />;

  const navItems: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "insights", label: "最新观点", icon: <Activity size={18} /> },
    { id: "creators", label: "博主管理", icon: <Users size={18} /> },
    { id: "accounts", label: "平台账号", icon: <KeyRound size={18} /> },
    { id: "runs", label: "采集记录", icon: <History size={18} /> },
    { id: "settings", label: "采集设置", icon: <Settings size={18} /> }
  ];
  const currentTitle = navItems.find((item) => item.id === tab)?.label || "Stockpulse";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark small"><Activity size={20} /></div><div><strong>Stockpulse</strong><span>观点监控</span></div></div>
        <nav>{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.icon}<span>{item.label}</span>{item.id === "runs" && hasActiveRun ? <i /> : null}</button>)}</nav>
        <div className="sidebar-status"><div><StatusDot status={bilibiliConnected ? "good" : "warn"} /><span>{bilibiliConnected ? "B 站已连接" : "B 站未连接"}</span></div><button className="icon-button" onClick={() => void logout()} title="退出登录" aria-label="退出登录"><LogOut size={17} /></button></div>
      </aside>

      <section className="main-column">
        <header className="page-header">
          <div><span className="eyebrow">自媒体投资观点</span><h1>{currentTitle}</h1></div>
          <div className="header-actions">
            <span className="monitor-count"><ShieldCheck size={16} />{enabledCreators.length} 个博主</span>
            <button className="primary-button compact" onClick={() => void runNow()} disabled={busyRun || hasActiveRun || !bilibiliConnected || !enabledCreators.length}>
              {busyRun || hasActiveRun ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}{hasActiveRun ? "采集中" : "立即采集"}
            </button>
          </div>
        </header>

        <nav className="mobile-nav">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
        {error ? <div className="global-error"><AlertTriangle size={18} /><span>{error}</span><button className="icon-clear" onClick={() => setError("")} title="关闭" aria-label="关闭"><X size={16} /></button></div> : null}

        <div className="page-content">
          {tab === "insights" ? <InsightsView insights={insights} creators={creators} date={insightDate} query={insightQuery} creatorId={creatorFilter} loading={loadingInsights} onDate={setInsightDate} onQuery={setInsightQuery} onCreator={setCreatorFilter} onRefresh={() => void loadInsights()} /> : null}
          {tab === "creators" ? <CreatorsView creators={creators} accountConnected={bilibiliConnected} onChanged={loadWorkspace} onRun={runNow} /> : null}
          {tab === "accounts" ? <AccountsView accounts={accounts} onChanged={loadWorkspace} /> : null}
          {tab === "runs" ? <RunsView runs={runs} onRefresh={() => void loadWorkspace()} /> : null}
          {tab === "settings" && settings ? <SettingsView settings={settings} onSaved={setSettings} /> : null}
        </div>
      </section>
    </main>
  );
}
