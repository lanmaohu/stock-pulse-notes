import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import {
  ArrowDownRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Eye,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  PencilLine,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  TrendingUp,
  WalletCards,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  PortfolioAccessLevel,
  PortfolioCurrency,
  PortfolioDraft,
  PortfolioDraftPosition,
  PortfolioDraftResponse,
  PortfolioPositionView,
  PortfolioResponse,
  PortfolioSessionResponse,
  PortfolioView as PortfolioViewType
} from "../shared/types";
import { api as portfolioApi } from "./api";
import "./portfolio.css";

const currencies: PortfolioCurrency[] = ["CNY", "HKD", "USD"];

function formatPercent(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value)}%`;
}

function formatPrice(value: number, currency: PortfolioCurrency) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value);
}

function formatCny(value?: number) {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    notation: Math.abs(value) >= 100000 ? "compact" : "standard",
    maximumFractionDigits: 2
  }).format(value);
}

function formatQuantity(value?: number) {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
}

function formatPublishedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function ReturnValue({ value }: { value: number | null }) {
  const className = value === null || value === 0 ? "flat" : value > 0 ? "positive" : "negative";
  return <span className={`portfolio-return ${className}`}>{formatPercent(value)}</span>;
}

function AssetLogo({ position }: { position: Pick<PortfolioPositionView, "logoUrl" | "symbol"> }) {
  return position.logoUrl ? (
    <img className="portfolio-asset-logo" src={position.logoUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="portfolio-asset-logo portfolio-logo-fallback">{position.symbol.slice(0, 2)}</span>
  );
}

type TreemapTile = PortfolioPositionView & { x: number; y: number; width: number; height: number; color: string };

function PortfolioTreemap({ portfolio }: { portfolio: PortfolioViewType }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = Math.max(360, Math.min(680, width * 0.62));
  const colors = useMemo(() => new Map(portfolio.sectors.map((sector) => [sector.name, sector.color])), [portfolio.sectors]);
  const tiles = useMemo(() => {
    if (!width) return [];
    const positions = portfolio.positions.filter((position) => position.weightPercent > 0);
    if (!positions.length) return [];
    const root = hierarchy<{ children?: PortfolioPositionView[]; value?: number }>({ children: positions })
      .sum((node) => "weightPercent" in node ? (node as unknown as PortfolioPositionView).weightPercent : 0)
      .sort((left, right) => (right.value || 0) - (left.value || 0));
    const layout = treemap<{ children?: PortfolioPositionView[]; value?: number }>()
      .size([width, height])
      .paddingInner(6)
      .paddingOuter(8)
      .round(true)
      .tile(treemapSquarify.ratio(1.25))(root);
    return layout.leaves().map((leaf, index) => {
      const position = leaf.data as unknown as PortfolioPositionView;
      return {
        ...position,
        x: leaf.x0,
        y: leaf.y0,
        width: Math.max(0, leaf.x1 - leaf.x0),
        height: Math.max(0, leaf.y1 - leaf.y0),
        color: colors.get(position.sector) || "#5369dc",
        sortOrder: index
      } satisfies TreemapTile;
    });
  }, [colors, height, portfolio.positions, width]);

  return (
    <div className="portfolio-map" ref={containerRef} style={{ height }}>
      {tiles.length ? tiles.map((tile) => {
        const compact = tile.width < 150 || tile.height < 110;
        const tiny = tile.width < 80 || tile.height < 65;
        return (
          <div
            key={tile.positionKey}
            className={`portfolio-map-tile${compact ? " compact" : ""}${tiny ? " tiny" : ""}`}
            style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height, background: tile.color }}
            title={`${tile.symbol} · ${tile.name} · ${formatPercent(tile.weightPercent)}`}
            role="img"
            tabIndex={0}
            aria-label={`${tile.symbol}，${tile.name}，仓位 ${formatPercent(tile.weightPercent)}`}
          >
            {!tiny ? <AssetLogo position={tile} /> : null}
            <strong>{tile.symbol}</strong>
            {!compact ? <span>{tile.name}</span> : null}
            <b>{formatPercent(tile.weightPercent)}</b>
          </div>
        );
      }) : (
        <div className="portfolio-map-empty"><BriefcaseBusiness size={30} /><span>发布有市值的持仓后，这里会生成仓位地图</span></div>
      )}
    </div>
  );
}

function PortfolioHeader({
  portfolio,
  accessLevel,
  onUnlock,
  onManage,
  onLogout
}: {
  portfolio: PortfolioViewType | null;
  accessLevel: PortfolioAccessLevel;
  onUnlock: () => void;
  onManage: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="portfolio-hero">
      <div className="portfolio-owner-mark">
        {portfolio?.avatarUrl ? <img src={portfolio.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <TrendingUp size={38} />}
      </div>
      <div className="portfolio-hero-copy">
        <div className="portfolio-owner-line"><span className="portfolio-live-dot" />{portfolio?.ownerName || "Stockpulse"}<small>个人投资组合</small></div>
        <h1>{portfolio?.title || "我的持仓全景图"}</h1>
        <p>{portfolio?.subtitle || "按板块分类的个人资产配置"}</p>
      </div>
      <div className="portfolio-hero-actions">
        {accessLevel === "public" ? (
          <button className="portfolio-outline-button" onClick={onUnlock}><LockKeyhole size={17} />解锁股数 / 成本</button>
        ) : (
          <button className="portfolio-outline-button unlocked" onClick={onLogout}><Eye size={17} />敏感数据已解锁<LogOut size={15} /></button>
        )}
        <button className="portfolio-admin-button" onClick={onManage}><PencilLine size={17} />管理持仓</button>
      </div>
    </header>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <article className={`portfolio-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function PortfolioDashboard({ portfolio, accessLevel }: { portfolio: PortfolioViewType; accessLevel: PortfolioAccessLevel }) {
  const grouped = useMemo(() => portfolio.sectors.map((sector) => ({
    sector,
    positions: portfolio.positions.filter((position) => position.sector === sector.name)
  })), [portfolio.positions, portfolio.sectors]);
  return (
    <>
      <section className="portfolio-metrics" aria-label="持仓概览">
        <MetricCard
          label="持仓浮盈"
          value={formatPercent(portfolio.summary.unrealizedReturnPercent, 2)}
          detail={accessLevel === "public" ? "按当前持仓成本计算" : `浮盈 ${formatCny(portfolio.summary.unrealizedPnlCny)}`}
          tone="return"
        />
        <MetricCard label="股票 / ETF" value={formatPercent(portfolio.summary.stockWeightPercent)} detail={`${portfolio.summary.holdingCount} 个标的`} tone="stock" />
        <MetricCard label="现金" value={formatPercent(portfolio.summary.cashWeightPercent)} detail={accessLevel === "public" ? "组合流动性" : formatCny(portfolio.summary.cashMarketValueCny)} tone="cash" />
        <MetricCard label="板块" value={`${portfolio.summary.sectorCount}`} detail={accessLevel === "public" ? "按人民币市值汇总" : `总资产 ${formatCny(portfolio.summary.totalAssetsCny)}`} tone="sector" />
      </section>

      <section className="portfolio-section">
        <div className="portfolio-section-heading"><div><span>01 / POSITION MAP</span><h2>持仓地图</h2></div><p>方块面积代表占总资产比例</p></div>
        <PortfolioTreemap portfolio={portfolio} />
      </section>

      <section className="portfolio-section">
        <div className="portfolio-section-heading"><div><span>02 / ALLOCATION</span><h2>板块配置</h2></div><p>股票与 ETF 合计 {formatPercent(portfolio.summary.stockWeightPercent)}</p></div>
        <div className="portfolio-allocation-bar" aria-label="板块仓位比例">
          {portfolio.sectors.filter((sector) => sector.weightPercent > 0).map((sector) => (
            <span key={sector.name} style={{ width: `${sector.weightPercent}%`, background: sector.color }} title={`${sector.name} ${formatPercent(sector.weightPercent)}`}>
              {sector.weightPercent >= 9 ? `${sector.name} ${formatPercent(sector.weightPercent)}` : ""}
            </span>
          ))}
          {portfolio.summary.cashWeightPercent > 0 ? <span className="cash" style={{ width: `${portfolio.summary.cashWeightPercent}%` }} title={`现金 ${formatPercent(portfolio.summary.cashWeightPercent)}`}>{portfolio.summary.cashWeightPercent >= 9 ? `现金 ${formatPercent(portfolio.summary.cashWeightPercent)}` : ""}</span> : null}
        </div>
        <div className="portfolio-legend">
          {portfolio.sectors.map((sector) => <span key={sector.name}><i style={{ background: sector.color }} />{sector.name}<b>{formatPercent(sector.weightPercent)}</b></span>)}
          {portfolio.summary.cashWeightPercent > 0 ? <span><i className="cash" />现金<b>{formatPercent(portfolio.summary.cashWeightPercent)}</b></span> : null}
        </div>
        <div className="portfolio-sector-grid">
          {grouped.map(({ sector, positions }) => (
            <article className="portfolio-sector-card" key={sector.name} style={{ "--sector-color": sector.color } as React.CSSProperties}>
              <header><div><span className="portfolio-sector-icon"><Landmark size={18} /></span><strong>{sector.name}</strong></div><b>{formatPercent(sector.weightPercent)}</b></header>
              <div className="portfolio-sector-progress"><span style={{ width: `${Math.min(100, sector.weightPercent)}%` }} /></div>
              <div className="portfolio-sector-positions">
                {positions.map((position) => <div key={position.positionKey}><span>{position.symbol}<small>{position.assetType === "etf" ? "ETF" : position.market}</small></span><ReturnValue value={position.returnPercent} /><b>{formatPercent(position.weightPercent)}</b></div>)}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="portfolio-section portfolio-detail-section">
        <div className="portfolio-section-heading"><div><span>03 / HOLDINGS</span><h2>持仓明细</h2></div><p>{accessLevel === "public" ? "解锁后查看股数、成本与仓位变化" : "已显示敏感持仓数据"}</p></div>
        <div className="portfolio-holdings-table">
          <div className="portfolio-holding-head"><span>标的</span><span>现价</span><span>浮盈率</span><span>仓位</span>{accessLevel !== "public" ? <><span>股数 / 成本</span><span>市值 / 变化</span></> : null}</div>
          {portfolio.positions.map((position) => (
            <div className="portfolio-holding-row" key={position.positionKey}>
              <div className="portfolio-holding-identity"><AssetLogo position={position} /><span><strong>{position.symbol}</strong><small>{position.name} · {position.sector}</small></span></div>
              <span data-label="现价">{formatPrice(position.lastPrice, position.currency)}</span>
              <ReturnValue value={position.returnPercent} />
              <strong data-label="仓位">{formatPercent(position.weightPercent)}</strong>
              {accessLevel !== "public" ? (
                <>
                  <span data-label="股数 / 成本">{formatQuantity(position.quantity)} 股<small>成本 {formatPrice(position.averageCost || 0, position.currency)}</small></span>
                  <span data-label="市值 / 变化">{formatCny(position.marketValueCny)}<small className={(position.quantityChange || 0) > 0 ? "positive" : (position.quantityChange || 0) < 0 ? "negative" : ""}>
                    {(position.quantityChange || 0) > 0 ? <ArrowUpRight size={13} /> : (position.quantityChange || 0) < 0 ? <ArrowDownRight size={13} /> : null}
                    较上次 {position.quantityChange === undefined || position.quantityChange === 0 ? "无变化" : `${position.quantityChange > 0 ? "+" : ""}${formatQuantity(position.quantityChange)} 股`}
                  </small></span>
                </>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {portfolio.cash.length ? (
        <section className="portfolio-cash-strip">
          <div><WalletCards size={19} /><strong>现金配置</strong></div>
          {portfolio.cash.map((cash) => <span key={cash.currency}><b>{cash.currency}</b>{accessLevel === "public" ? formatPercent(cash.weightPercent) : `${formatQuantity(cash.balance)} · ${formatCny(cash.marketValueCny)}`}</span>)}
        </section>
      ) : null}

      <footer className="portfolio-page-footer"><span>更新日期 · {formatPublishedAt(portfolio.publishedAt)}</span><span>面积 / 长度代表仓位占比 · 数据由本人提供 · 仅供个人记录，非投资建议</span></footer>
    </>
  );
}

function PasswordDialog({ role, onClose, onSuccess }: { role: "viewer" | "admin"; onClose: () => void; onSuccess: (access: PortfolioAccessLevel) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await portfolioApi<PortfolioSessionResponse>("/api/portfolio/session", { method: "POST", body: JSON.stringify({ role, password }) });
      onSuccess(result.accessLevel);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="portfolio-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="portfolio-password-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-password-title" onSubmit={submit}>
        <button className="portfolio-dialog-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <span className="portfolio-dialog-icon">{role === "admin" ? <ShieldCheck size={24} /> : <LockKeyhole size={24} />}</span>
        <h2 id="portfolio-password-title">{role === "admin" ? "管理员验证" : "解锁持仓详情"}</h2>
        <p>{role === "admin" ? "验证后可编辑草稿并发布新的持仓快照。" : "输入查看密码后，可查看股数、成本、金额和仓位变化。"}</p>
        <label><span>密码</span><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" /></label>
        {error ? <div className="portfolio-form-error">{error}</div> : null}
        <button className="portfolio-primary-action" type="submit" disabled={busy || !password}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}确认</button>
      </form>
    </div>
  );
}

function numericInput(value: number, onChange: (value: number) => void, options: { step?: string; min?: string } = {}) {
  return <input type="number" min={options.min || "0"} step={options.step || "any"} value={value} onChange={(event) => onChange(Number(event.target.value))} />;
}

export function PortfolioAdminDrawer({ onClose, onPublished, embedded = false }: { onClose: () => void; onPublished: (portfolio: PortfolioResponse) => void; embedded?: boolean }) {
  const [response, setResponse] = useState<PortfolioDraftResponse | null>(null);
  const [draft, setDraft] = useState<PortfolioDraft | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadDraft = useCallback(async () => {
    try {
      const result = await portfolioApi<PortfolioDraftResponse>("/api/portfolio/admin/draft");
      setResponse(result);
      setDraft(result.draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "草稿加载失败。");
    }
  }, []);
  useEffect(() => { void loadDraft(); }, [loadDraft]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editorDirty) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [editorDirty, onClose]);

  function changeDraft(update: (current: PortfolioDraft) => PortfolioDraft) {
    setDraft((current) => current ? update(current) : current);
    setEditorDirty(true);
    setNotice("");
  }
  function updatePosition(index: number, update: Partial<PortfolioDraftPosition>) {
    changeDraft((current) => ({ ...current, positions: current.positions.map((position, itemIndex) => itemIndex === index ? { ...position, ...update } : position) }));
  }
  function addPosition() {
    changeDraft((current) => ({
      ...current,
      positions: [...current.positions, {
        positionKey: crypto.randomUUID(), symbol: "", name: "", assetType: "stock", market: "美股", sector: "其他",
        currency: "USD", quantity: 0, averageCost: 0, lastPrice: 0, sortOrder: current.positions.length
      }]
    }));
  }
  function removePosition(index: number) {
    changeDraft((current) => ({ ...current, positions: current.positions.filter((_, itemIndex) => itemIndex !== index).map((position, sortOrder) => ({ ...position, sortOrder })) }));
  }
  async function saveDraft(silent = false) {
    if (!draft) throw new Error("草稿尚未加载。");
    const result = await portfolioApi<PortfolioDraftResponse>("/api/portfolio/admin/draft", { method: "PUT", body: JSON.stringify(draft) });
    setResponse(result);
    setDraft(result.draft);
    setEditorDirty(false);
    if (!silent) setNotice("草稿已保存，公开页面尚未更新。");
    return result;
  }
  async function handleSave() {
    setBusy(true); setError(""); setNotice("");
    try { await saveDraft(); } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败。"); } finally { setBusy(false); }
  }
  async function handlePublish() {
    if (!window.confirm("确认发布当前草稿？公开页面将整体切换到这个版本。")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (editorDirty) await saveDraft(true);
      const published = await portfolioApi<PortfolioResponse>("/api/portfolio/admin/publish", { method: "POST" });
      setNotice("持仓快照已发布。");
      onPublished(published);
      await loadDraft();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "发布失败。");
    } finally {
      setBusy(false);
    }
  }
  function requestClose() {
    if (!editorDirty || window.confirm("尚有未保存修改，确认关闭？")) onClose();
  }

  return (
    <div className={embedded ? "portfolio-admin-embedded" : "portfolio-drawer-backdrop"} role="presentation">
      <aside className={`portfolio-admin-drawer${embedded ? " embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : "true"} aria-labelledby="portfolio-admin-title">
        <header><div><span>PORTFOLIO CONSOLE</span><h2 id="portfolio-admin-title">管理持仓</h2></div>{!embedded ? <button type="button" onClick={requestClose} aria-label="关闭管理"><X size={20} /></button> : null}</header>
        {!draft ? <div className="portfolio-admin-loading"><LoaderCircle className="spin" size={22} />正在加载草稿</div> : (
          <div className="portfolio-admin-body">
            <div className="portfolio-draft-status">
              <span className={(response?.dirty || editorDirty) ? "dirty" : "synced"}>{(response?.dirty || editorDirty) ? "草稿未发布" : "已与公开版本同步"}</span>
              {response?.latestPublishedAt ? <small>最近发布 {formatPublishedAt(response.latestPublishedAt)}</small> : <small>尚未发布过持仓</small>}
            </div>

            <section className="portfolio-admin-section">
              <h3>页面资料</h3>
              <div className="portfolio-admin-grid">
                <label><span>页面标题</span><input value={draft.title} onChange={(event) => changeDraft((current) => ({ ...current, title: event.target.value }))} /></label>
                <label><span>展示名称</span><input value={draft.ownerName} onChange={(event) => changeDraft((current) => ({ ...current, ownerName: event.target.value }))} /></label>
                <label className="wide"><span>副标题</span><input value={draft.subtitle} onChange={(event) => changeDraft((current) => ({ ...current, subtitle: event.target.value }))} /></label>
                <label className="wide"><span>头像 HTTPS 地址（可选）</span><input type="url" value={draft.avatarUrl || ""} onChange={(event) => changeDraft((current) => ({ ...current, avatarUrl: event.target.value || undefined }))} placeholder="https://..." /></label>
              </div>
            </section>

            <section className="portfolio-admin-section">
              <h3>汇率与现金</h3>
              <div className="portfolio-money-grid">
                {currencies.map((currency) => {
                  const fx = draft.fxRates.find((item) => item.currency === currency)?.rateToCny || 1;
                  const cash = draft.cashBalances.find((item) => item.currency === currency)?.balance || 0;
                  return <div key={currency}><strong>{currency}</strong><label><span>兑人民币</span>{numericInput(currency === "CNY" ? 1 : fx, (value) => changeDraft((current) => ({ ...current, fxRates: current.fxRates.map((item) => item.currency === currency ? { ...item, rateToCny: value } : item) })), { step: "0.0001" })}</label><label><span>现金余额</span>{numericInput(cash, (value) => changeDraft((current) => ({ ...current, cashBalances: current.cashBalances.map((item) => item.currency === currency ? { ...item, balance: value } : item) })))}</label></div>;
                })}
              </div>
            </section>

            <section className="portfolio-admin-section">
              <div className="portfolio-admin-section-title"><h3>股票与 ETF</h3><button type="button" onClick={addPosition}><Plus size={16} />添加持仓</button></div>
              <div className="portfolio-position-editor-list">
                {draft.positions.length ? draft.positions.map((position, index) => (
                  <article className="portfolio-position-editor" key={position.positionKey}>
                    <div className="portfolio-position-editor-head"><strong>{position.symbol || `新持仓 ${index + 1}`}</strong><button type="button" onClick={() => removePosition(index)} aria-label={`删除 ${position.symbol || "持仓"}`}><Trash2 size={16} /></button></div>
                    <div className="portfolio-admin-grid compact">
                      <label><span>代码</span><input value={position.symbol} onChange={(event) => updatePosition(index, { symbol: event.target.value.toUpperCase() })} placeholder="AAPL" /></label>
                      <label><span>名称</span><input value={position.name} onChange={(event) => updatePosition(index, { name: event.target.value })} placeholder="Apple" /></label>
                      <label><span>资产类型</span><select value={position.assetType} onChange={(event) => updatePosition(index, { assetType: event.target.value as "stock" | "etf" })}><option value="stock">股票</option><option value="etf">ETF</option></select></label>
                      <label><span>市场</span><input value={position.market} onChange={(event) => updatePosition(index, { market: event.target.value })} placeholder="美股" /></label>
                      <label><span>板块</span><input value={position.sector} onChange={(event) => updatePosition(index, { sector: event.target.value })} placeholder="科技" /></label>
                      <label><span>币种</span><select value={position.currency} onChange={(event) => updatePosition(index, { currency: event.target.value as PortfolioCurrency })}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
                      <label><span>股数</span>{numericInput(position.quantity, (value) => updatePosition(index, { quantity: value }))}</label>
                      <label><span>平均成本</span>{numericInput(position.averageCost, (value) => updatePosition(index, { averageCost: value }))}</label>
                      <label><span>最新价</span>{numericInput(position.lastPrice, (value) => updatePosition(index, { lastPrice: value }))}</label>
                      <label className="wide"><span>Logo HTTPS 地址（可选）</span><input type="url" value={position.logoUrl || ""} onChange={(event) => updatePosition(index, { logoUrl: event.target.value || undefined })} placeholder="https://..." /></label>
                    </div>
                  </article>
                )) : <div className="portfolio-editor-empty"><CircleDollarSign size={24} /><span>还没有持仓，点击“添加持仓”开始录入。</span></div>}
              </div>
            </section>
          </div>
        )}
        <footer>
          <div>{error ? <span className="error">{error}</span> : notice ? <span className="success"><CheckCircle2 size={15} />{notice}</span> : null}</div>
          <button className="portfolio-secondary-action" type="button" onClick={() => void handleSave()} disabled={busy || !draft}><Save size={17} />保存草稿</button>
          <button className="portfolio-primary-action" type="button" onClick={() => void handlePublish()} disabled={busy || !draft}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}发布快照</button>
        </footer>
      </aside>
    </div>
  );
}

export function PortfolioView({
  onManage,
  adminMode = false
}: {
  onManage?: () => void;
  adminMode?: boolean;
}) {
  const [response, setResponse] = useState<PortfolioResponse>({ accessLevel: "public", portfolio: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loginRole, setLoginRole] = useState<"viewer" | "admin" | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const loadPortfolio = useCallback(async () => {
    setLoading(true);
    try {
      setResponse(await portfolioApi<PortfolioResponse>("/api/portfolio"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "持仓加载失败。");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadPortfolio();
  }, [loadPortfolio]);

  async function logout() {
    try {
      await portfolioApi<PortfolioSessionResponse>("/api/portfolio/session", { method: "DELETE" });
      setAdminOpen(false);
      await loadPortfolio();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "退出失败。");
    }
  }
  function manage() {
    if (onManage) return onManage();
    if (response.accessLevel === "admin") setAdminOpen(true);
    else setLoginRole("admin");
  }
  async function loginSucceeded(accessLevel: PortfolioAccessLevel) {
    setLoginRole(null);
    await loadPortfolio();
    if (accessLevel === "admin") setAdminOpen(true);
  }

  if (adminMode) {
    return <div className="portfolio-page admin-portfolio-page"><PortfolioAdminDrawer embedded onClose={() => undefined} onPublished={() => undefined} /></div>;
  }

  return (
    <div className="portfolio-page">
      <div className="portfolio-page-inner">
        <PortfolioHeader portfolio={response.portfolio} accessLevel={response.accessLevel} onUnlock={() => setLoginRole("viewer")} onManage={manage} onLogout={() => void logout()} />
        {error ? <div className="portfolio-load-error"><span>{error}</span><button onClick={() => void loadPortfolio()}>重新加载<ChevronRight size={15} /></button></div> : null}
        {loading ? <div className="portfolio-loading"><LoaderCircle className="spin" size={24} />正在整理持仓全景</div> : response.portfolio ? (
          <PortfolioDashboard portfolio={response.portfolio} accessLevel={response.accessLevel} />
        ) : (
          <section className="portfolio-empty-state"><span><BriefcaseBusiness size={34} /></span><h2>还没有公开的持仓快照</h2><p>管理员可以先录入汇率、现金和股票数据，保存草稿并确认发布。</p><button onClick={manage}><PencilLine size={17} />开始管理持仓</button></section>
        )}
      </div>
      {loginRole ? <PasswordDialog role={loginRole} onClose={() => setLoginRole(null)} onSuccess={(access) => void loginSucceeded(access)} /> : null}
      {adminOpen ? <PortfolioAdminDrawer onClose={() => setAdminOpen(false)} onPublished={(portfolio) => setResponse(portfolio)} /> : null}
    </div>
  );
}
