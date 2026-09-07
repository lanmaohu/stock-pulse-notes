import {
  Activity,
  AlertTriangle,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LogIn,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Layers3,
  ScanLine,
  Video,
  X
} from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import type {
  ContentInsight,
  ContentCreatorOption,
  ContentCreatorOptionsResponse,
  ContentInsightsPageSize,
  ContentInsightsPagination,
  ContentInsightsResponse,
  ContentInsightsSummary,
  ViewConfidence,
  ViewStance
} from "../shared/types";
import { siteConfig } from "./siteConfig";
import { api } from "./api";
import { AdminAuthProvider, useAdminAuth } from "./AdminAuth";
import { EmptyState, FilingFooter, formatDate, platformLabel } from "./ui";
import { WorkspaceMobileNavigation, WorkspaceSidebar } from "./WorkspaceNavigation";

const PortfolioView = lazy(() => import("./PortfolioView").then((module) => ({ default: module.PortfolioView })));
const AdminApp = lazy(() => import("./AdminApp"));

function PortfolioRouteFallback() {
  return <div className="route-loading"><LoaderCircle className="spin" size={24} />正在加载持仓</div>;
}

function usePageMetadata(title: string, robots: string) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (meta) meta.content = robots;
  }, [robots, title]);
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

const insightPageSizeStorageKey = "stockpulse:insights-page-size";

function storedInsightPageSize(): ContentInsightsPageSize {
  if (typeof window === "undefined") return 10;
  try {
    const value = Number(window.localStorage.getItem(insightPageSizeStorageKey));
    return value === 20 || value === 50 ? value : 10;
  } catch {
    return 10;
  }
}

function rememberInsightPageSize(value: ContentInsightsPageSize) {
  try {
    window.localStorage.setItem(insightPageSizeStorageKey, String(value));
  } catch {
    // Private browsing or storage policies can disable local persistence.
  }
}

function visiblePages(currentPage: number, totalPages: number): Array<number | string> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const validPages = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((left, right) => left - right);
  const items: Array<number | string> = [];
  for (const page of validPages) {
    const previous = items.at(-1);
    if (typeof previous === "number" && page - previous > 1) items.push(`ellipsis-${previous}`);
    items.push(page);
  }
  return items;
}

const stanceLabel: Record<ViewStance, string> = {
  bullish: "看多",
  bearish: "看空",
  neutral: "中性",
  mixed: "分歧",
  watch: "观察"
};

const confidenceLabel: Record<ViewConfidence, string> = { high: "高置信", medium: "中置信", low: "低置信" };

function TranscriptPanel({ content }: { content: ContentInsight["content"] }) {
  const [expanded, setExpanded] = useState(false);
  const isBody = content.transcriptSource === "body";
  if (content.contentType !== "video" && !isBody) return null;

  const transcript = content.transcriptSource === "metadata" ? "" : content.transcript.trim();
  const hasTranscript = Boolean(transcript);
  const sourcePlatformLabel = content.platform === "bilibili" ? "B 站" : platformLabel[content.platform];
  const sourceLabel = isBody ? "正文内容" : `${sourcePlatformLabel}字幕文字稿`;
  return (
    <details
      className={`transcript-panel${hasTranscript ? "" : " unavailable"}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>{hasTranscript ? sourceLabel : `${sourcePlatformLabel}字幕文字稿 · 未获取`}</span>
        {hasTranscript ? <small>{transcript.length.toLocaleString("zh-CN")} 字</small> : null}
      </summary>
      {expanded ? (
        hasTranscript ? (
          <div className="transcript-copy">{transcript}</div>
        ) : (
          <p className="transcript-unavailable">该视频暂未获取到平台字幕，当前观点仅依据标题、简介和标签生成。</p>
        )
      ) : null}
    </details>
  );
}

function ContentSummaryPanel({ content }: { content: ContentInsight["content"] }) {
  if (!content.summarySections.length) return null;
  const headingId = `content-summary-${content.id}`;
  return (
    <section className="transcript-summary" aria-labelledby={headingId}>
      <div className="transcript-summary-heading">
        <span><BookOpen size={18} /></span>
        <div>
          <h2 id={headingId}>内容摘要</h2>
          <p>严格依据字幕整理 · 按内容顺序分段</p>
        </div>
      </div>
      <div className="summary-section-list">
        {content.summarySections.map((section, index) => (
          <article className="summary-section" key={`${section.heading}-${index}`}>
            <span className="summary-section-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div className="summary-section-copy">
              <h3>{section.heading}</h3>
              <p>{section.body}</p>
              <details className="summary-evidence">
                <summary>查看原文依据</summary>
                <div>
                  {section.sourceQuotes.map((quote, quoteIndex) => (
                    <blockquote key={`${quote}-${quoteIndex}`}>{quote}</blockquote>
                  ))}
                </div>
              </details>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function InsightCard({ insight, canRetry, onRetry }: {
  insight: ContentInsight;
  canRetry: boolean;
  onRetry: (contentId: string) => Promise<void>;
}) {
  const { content, views } = insight;
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const detailsId = `insight-details-${content.id}`;
  const displayedAnalysisStatus = retrying ? "running" : content.analysisStatus;

  async function retryAnalysis() {
    setRetryError("");
    setRetrying(true);
    try {
      await onRetry(content.id);
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "重新分析失败。请稍后再试。");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <article className={`insight-card${expanded ? " expanded" : ""}`}>
      <div className="content-overview" onClick={() => setExpanded((current) => !current)}>
        {content.coverUrl ? (
          <a className="cover-link" href={content.sourceUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${content.title}`} onClick={(event) => event.stopPropagation()}>
            <img src={content.coverUrl} alt="" referrerPolicy="no-referrer" />
            <span><Play size={18} fill="currentColor" /></span>
          </a>
        ) : (
          <div className="cover-placeholder"><Video size={28} /></div>
        )}
        <div className="content-summary">
          <div className="content-heading">
            <div className="content-kicker">
              <span className={`platform-badge ${content.platform}`}>{platformLabel[content.platform]}</span>
              <strong>{content.creatorName}</strong>
              <span>发布 {formatDate(content.publishedAt)}</span>
              <span>采集 {formatDate(content.collectedAt)}</span>
            </div>
            <a className="content-title" href={content.sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
              {content.title}<ExternalLink size={15} />
            </a>
            <div className="content-state">
              <span className={`analysis-state ${displayedAnalysisStatus}`}>
                {displayedAnalysisStatus === "success"
                  ? "分析完成"
                  : displayedAnalysisStatus === "running"
                    ? "分析中"
                    : displayedAnalysisStatus === "error"
                      ? "分析失败"
                      : "等待分析"}
              </span>
              <span>{content.transcriptSource === "subtitle" ? "字幕内容" : content.transcriptSource === "body" ? "正文内容" : "仅元数据"}</span>
              {content.analysisStatus === "success" && views.length > 0 ? <span className="view-count">{views.length} 条观点</span> : null}
            </div>
          </div>
          <button
            type="button"
            className="insight-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? "收起" : "展开"}观点：${content.title}`}
          >
            <span>{expanded ? "收起" : "阅读观点"}</span>
            <ChevronDown size={19} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="insight-details" id={detailsId}>
          <TranscriptPanel content={content} />
          <ContentSummaryPanel content={content} />

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
            <div className={`analysis-message ${displayedAnalysisStatus}`} aria-live="polite">
              <div className="analysis-message-copy">
                {displayedAnalysisStatus === "error" ? <AlertTriangle size={17} /> : <LoaderCircle className={displayedAnalysisStatus === "running" ? "spin" : ""} size={17} />}
                <span>{retrying ? "正在重新分析，请稍候。" : retryError || content.error || (content.analysisStatus === "success" ? "内容中没有识别到投资观点。" : "投资观点正在生成。")}</span>
              </div>
              {canRetry && content.analysisStatus === "error" ? (
                <button type="button" className="analysis-retry-button" onClick={() => void retryAnalysis()} disabled={retrying}>
                  <RefreshCw className={retrying ? "spin" : ""} size={15} />
                  {retrying ? "重新分析中" : "重新分析"}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

function InsightsView({
  insights,
  pagination,
  summary,
  creators,
  date,
  query,
  creatorId,
  loading,
  onDate,
  onQuery,
  onCreator,
  onPage,
  onPageSize,
  onRefresh,
  canRetry,
  onRetry
}: {
  insights: ContentInsight[];
  pagination: ContentInsightsPagination;
  summary: ContentInsightsSummary;
  creators: ContentCreatorOption[];
  date: string;
  query: string;
  creatorId: string;
  loading: boolean;
  onDate: (value: string) => void;
  onQuery: (value: string) => void;
  onCreator: (value: string) => void;
  onPage: (value: number) => void;
  onPageSize: (value: ContentInsightsPageSize) => void;
  onRefresh: () => void;
  canRetry: boolean;
  onRetry: (contentId: string) => Promise<void>;
}) {
  const listTopRef = useRef<HTMLElement>(null);

  function changePage(page: number) {
    if (page === pagination.page || page < 1 || page > pagination.totalPages) return;
    onPage(page);
    window.requestAnimationFrame(() => listTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <>
      <section className="metric-row" aria-label="当前筛选统计">
        <div><span className="metric-label"><Video size={16} />内容</span><strong>{loading ? "—" : summary.contentCount.toLocaleString("zh-CN")}</strong><small>已收录的视频与图文</small></div>
        <div><span className="metric-label"><Layers3 size={16} />观点</span><strong>{loading ? "—" : summary.viewCount.toLocaleString("zh-CN")}</strong><small>从原始内容提取整理</small></div>
        <div><span className="metric-label"><ScanLine size={16} />涉及标的</span><strong>{loading ? "—" : summary.targetCount.toLocaleString("zh-CN")}</strong><small>发现观点之间的关联</small></div>
      </section>
      <div className="feed-heading"><h2>内容动态<span>FEED</span></h2><p>循着观点，回到原文</p></div>
      <section className="filter-bar" ref={listTopRef}>
        <div className="date-filter">
          <CalendarDays size={17} />
          <input type="date" value={date} onChange={(event) => onDate(event.target.value)} aria-label="发布日期" />
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
        <button className="icon-button" onClick={onRefresh} disabled={loading} title="刷新观点" aria-label="刷新观点"><RefreshCw className={loading ? "spin" : undefined} size={17} /></button>
      </section>
      {loading ? (
        <div className="loading-line"><LoaderCircle className="spin" size={18} />正在加载观点</div>
      ) : insights.length ? (
        <>
          <section className="insight-list">{insights.map((insight) => <InsightCard key={insight.content.id} insight={insight} canRetry={canRetry} onRetry={onRetry} />)}</section>
          <nav className="insight-pagination" aria-label="观点分页">
            <span className="pagination-summary">共 {pagination.totalItems} 条</span>
            <div className="pagination-pages">
              <button type="button" onClick={() => changePage(pagination.page - 1)} disabled={pagination.page <= 1} aria-label="上一页"><ChevronLeft size={16} /></button>
              {visiblePages(pagination.page, pagination.totalPages).map((item) => typeof item === "number" ? (
                <button
                  type="button"
                  key={item}
                  className={item === pagination.page ? "active" : ""}
                  aria-current={item === pagination.page ? "page" : undefined}
                  onClick={() => changePage(item)}
                >{item}</button>
              ) : <span className="pagination-ellipsis" key={item} aria-hidden="true">…</span>)}
              <button type="button" onClick={() => changePage(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} aria-label="下一页"><ChevronRight size={16} /></button>
            </div>
            <label className="page-size-select">
              <span>每页</span>
              <select value={pagination.pageSize} onChange={(event) => onPageSize(Number(event.target.value) as ContentInsightsPageSize)} aria-label="每页条数">
                <option value="10">10 条</option>
                <option value="20">20 条</option>
                <option value="50">50 条</option>
              </select>
            </label>
          </nav>
        </>
      ) : (
        <EmptyState icon={<Activity size={26} />} title="没有匹配的观点" detail={date ? "当天没有已发布内容，可以查看全部发布日期或开始一次采集。" : "添加博主并完成首次采集后，观点会显示在这里。"} />
      )}
    </>
  );
}

function PublicShell({ title, portfolio = false, children }: { title: string; portfolio?: boolean; children: React.ReactNode }) {
  const { authenticated, checking } = useAdminAuth();
  return (
    <main className={`app-shell${portfolio ? "" : " insights-shell"}`}>
      <WorkspaceSidebar />
      <section className="main-column">
        {!portfolio ? <header className="page-header"><div><span className="eyebrow">RESEARCH DESK <i /> 自媒体投资观点</span><h1>{title}<span className="heading-period" aria-hidden="true">.</span></h1><p className="page-description">汇集不同视角，让判断有据可循。</p></div>{!checking ? <Link className="secondary-button" to={authenticated ? "/admin/creators" : "/admin/login"}>{authenticated ? <ShieldCheck size={16} /> : <LogIn size={16} />}{authenticated ? "管理后台" : "管理员登录"}</Link> : null}</header> : null}
        <WorkspaceMobileNavigation />
        {children}
        <FilingFooter />
      </section>
    </main>
  );
}

function InsightsPage() {
  const { authenticated } = useAdminAuth();
  const [creators, setCreators] = useState<ContentCreatorOption[]>([]);
  const [insights, setInsights] = useState<ContentInsight[]>([]);
  const [date, setDate] = useState("");
  const [query, setQuery] = useState("");
  const [creatorId, setCreatorId] = useState("");
  const [pageSize, setPageSize] = useState<ContentInsightsPageSize>(storedInsightPageSize);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<ContentInsightsPagination>({ page: 1, pageSize, totalItems: 0, totalPages: 0 });
  const [summary, setSummary] = useState<ContentInsightsSummary>({ contentCount: 0, viewCount: 0, targetCount: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  usePageMetadata(`${siteConfig.name}｜自媒体投资观点监控`, "index,follow");

  useEffect(() => {
    void api<ContentCreatorOptionsResponse>("/api/content-creators")
      .then((result) => setCreators(result.creators))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "博主筛选加载失败。"));
  }, []);

  const loadInsights = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const sequence = ++requestSequence.current;
    if (!background) setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (date) params.set("publishedDate", date);
      if (query.trim()) params.set("q", query.trim());
      if (creatorId) params.set("creatorId", creatorId);
      const result = await api<ContentInsightsResponse>(`/api/content-insights?${params}`, { signal: controller.signal });
      if (sequence !== requestSequence.current) return;
      setInsights(result.insights);
      setPagination(result.pagination);
      setSummary(result.summary);
      setPage(result.pagination.page);
      setError("");
    } catch (caught) {
      if (sequence === requestSequence.current && !(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "观点加载失败。");
      }
    } finally {
      if (sequence === requestSequence.current && !background) setLoading(false);
    }
  }, [creatorId, date, page, pageSize, query]);

  const retryAnalysis = useCallback(async (contentId: string) => {
    const retried = await api<ContentInsight>(`/api/content-items/${encodeURIComponent(contentId)}/analysis-retry`, { method: "POST" });
    setInsights((current) => current.map((insight) => insight.content.id === contentId ? retried : insight));
    await loadInsights({ background: true });
  }, [loadInsights]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadInsights(), query ? 300 : 0);
    return () => {
      window.clearTimeout(timer);
      requestController.current?.abort();
    };
  }, [loadInsights, query]);

  return <PublicShell title="最新观点"><div className="page-content">
    {error ? <div className="global-error"><AlertTriangle size={18} /><span>{error}</span><button className="icon-clear" onClick={() => setError("")} aria-label="关闭"><X size={16} /></button></div> : null}
    <InsightsView insights={insights} pagination={pagination} summary={summary} creators={creators} date={date} query={query} creatorId={creatorId} loading={loading}
      onDate={(value) => { setDate(value); setPage(1); }} onQuery={(value) => { setQuery(value); setPage(1); }} onCreator={(value) => { setCreatorId(value); setPage(1); }}
      onPage={setPage} onPageSize={(value) => { rememberInsightPageSize(value); setPageSize(value); setPage(1); }} onRefresh={() => void loadInsights()}
      canRetry={authenticated} onRetry={retryAnalysis} />
  </div></PublicShell>;
}

function AdminPortfolioPage() {
  const navigate = useNavigate();
  const { authenticated, checking } = useAdminAuth();
  usePageMetadata(`${siteConfig.name}｜个人持仓全景图`, "noindex,nofollow");
  if (checking) return <PortfolioRouteFallback />;
  if (!authenticated) return <Navigate to="/admin/login?next=%2Fportfolio" replace />;
  return <PublicShell title="个人持仓" portfolio><Suspense fallback={<PortfolioRouteFallback />}><PortfolioView onManage={() => navigate("/admin/portfolio")} /></Suspense></PublicShell>;
}

class RouteErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="route-error"><AlertTriangle size={28} /><h1>页面暂时无法显示</h1><p>请刷新页面重试。</p><button className="primary-button" onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}


export function App() {
  return <RouteErrorBoundary><BrowserRouter><AdminAuthProvider><Routes>
    <Route path="/" element={<InsightsPage />} />
    <Route path="/portfolio" element={<AdminPortfolioPage />} />
    <Route path="/admin/*" element={<Suspense fallback={<div className="route-loading"><LoaderCircle className="spin" size={24} />正在加载管理后台</div>}><AdminApp /></Suspense>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></AdminAuthProvider></BrowserRouter></RouteErrorBoundary>;
}
