import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  PortfolioAccessLevel,
  PortfolioCashBalance,
  PortfolioCashView,
  PortfolioCurrency,
  PortfolioDraft,
  PortfolioDraftPosition,
  PortfolioDraftResponse,
  PortfolioFxRate,
  PortfolioPositionView,
  PortfolioResponse,
  PortfolioSectorView,
  PortfolioView
} from "../../shared/types.js";
import { database, withTransaction } from "../database/connection.js";

type PortfolioSnapshotRow = {
  id: string;
  status: "draft" | "published";
  title: string;
  subtitle: string;
  ownerName: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};
type PortfolioPositionRow = Omit<PortfolioDraftPosition, "logoUrl"> & {
  id: string;
  snapshotId: string;
  logoUrl: string | null;
};
type PortfolioCashRow = PortfolioCashBalance & { id: string; snapshotId: string };
type PortfolioFxRow = PortfolioFxRate & { id: string; snapshotId: string };

const currencies: PortfolioCurrency[] = ["CNY", "HKD", "USD"];
const sectorColors = ["#bf2f25", "#83b92f", "#32312f", "#42a7d6", "#cf672c", "#5369dc", "#9a58b5", "#178a78"];

function numberValue(value: unknown, label: string, options: { positive?: boolean } = {}) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (options.positive && number <= 0)) {
    throw new Error(`${label}必须是${options.positive ? "大于 0" : "不小于 0"}的数字。`);
  }
  return number;
}

function textValue(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, maxLength);
}

function imageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") throw new Error("图片地址必须使用 HTTPS。");
    return url.toString().slice(0, 1_000);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "图片地址无效。");
  }
}

function currencyValue(value: unknown): PortfolioCurrency {
  if (value === "CNY" || value === "HKD" || value === "USD") return value;
  throw new Error("币种只支持 CNY、HKD 或 USD。");
}

function normalizeDraft(input: PortfolioDraft): PortfolioDraft {
  if (!input || typeof input !== "object") throw new Error("持仓草稿格式不正确。");
  if (!Array.isArray(input.positions) || input.positions.length > 200) throw new Error("持仓数量不能超过 200 条。");
  const seenKeys = new Set<string>();
  const seenSymbols = new Set<string>();
  const positions = input.positions.map((position, index) => {
    const positionKey = /^[a-zA-Z0-9_-]{8,80}$/.test(position.positionKey || "")
      ? position.positionKey
      : crypto.randomUUID();
    const symbol = textValue(position.symbol, "", 24).toUpperCase();
    const market = textValue(position.market, "", 40);
    if (!symbol || !market) throw new Error(`第 ${index + 1} 条持仓缺少代码或市场。`);
    const uniquenessKey = `${market.toLowerCase()}::${symbol.toLowerCase()}`;
    if (seenKeys.has(positionKey) || seenSymbols.has(uniquenessKey)) throw new Error("同一市场不能存在重复持仓代码。");
    seenKeys.add(positionKey);
    seenSymbols.add(uniquenessKey);
    if (position.assetType !== "stock" && position.assetType !== "etf") throw new Error("资产类型只支持股票或 ETF。");
    return {
      positionKey,
      symbol,
      name: textValue(position.name, symbol, 80),
      assetType: position.assetType,
      market,
      sector: textValue(position.sector, "其他", 40),
      currency: currencyValue(position.currency),
      quantity: numberValue(position.quantity, `${symbol} 股数`),
      averageCost: numberValue(position.averageCost, `${symbol} 平均成本`),
      lastPrice: numberValue(position.lastPrice, `${symbol} 最新价`),
      logoUrl: imageUrl(position.logoUrl),
      sortOrder: index
    } satisfies PortfolioDraftPosition;
  });
  const cashByCurrency = new Map<PortfolioCurrency, number>();
  for (const cash of Array.isArray(input.cashBalances) ? input.cashBalances : []) {
    const currency = currencyValue(cash.currency);
    if (cashByCurrency.has(currency)) throw new Error(`现金币种 ${currency} 重复。`);
    cashByCurrency.set(currency, numberValue(cash.balance, `${currency} 现金`));
  }
  const fxByCurrency = new Map<PortfolioCurrency, number>();
  for (const fx of Array.isArray(input.fxRates) ? input.fxRates : []) {
    const currency = currencyValue(fx.currency);
    if (fxByCurrency.has(currency)) throw new Error(`汇率币种 ${currency} 重复。`);
    fxByCurrency.set(currency, currency === "CNY" ? 1 : numberValue(fx.rateToCny, `${currency} 汇率`, { positive: true }));
  }
  for (const position of positions) {
    if (position.currency !== "CNY" && !fxByCurrency.has(position.currency)) throw new Error(`请填写 ${position.currency} 兑人民币汇率。`);
  }
  return {
    id: input.id || "",
    title: textValue(input.title, "我的持仓全景图", 80),
    subtitle: textValue(input.subtitle, "按板块分类的个人资产配置", 160),
    ownerName: textValue(input.ownerName, "Stockpulse", 80),
    avatarUrl: imageUrl(input.avatarUrl),
    positions,
    cashBalances: currencies.map((currency) => ({ currency, balance: cashByCurrency.get(currency) || 0 })),
    fxRates: currencies.map((currency) => ({ currency, rateToCny: currency === "CNY" ? 1 : fxByCurrency.get(currency) || 1 })),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function readSnapshot(connection: DatabaseSync, row: PortfolioSnapshotRow): PortfolioDraft {
  const positions = connection.prepare("SELECT * FROM portfolio_positions WHERE snapshotId = ? ORDER BY sortOrder ASC, rowid ASC")
    .all(row.id) as PortfolioPositionRow[];
  const cash = connection.prepare("SELECT * FROM portfolio_cash_balances WHERE snapshotId = ? ORDER BY currency ASC")
    .all(row.id) as unknown as PortfolioCashRow[];
  const fxRates = connection.prepare("SELECT * FROM portfolio_fx_rates WHERE snapshotId = ? ORDER BY currency ASC")
    .all(row.id) as unknown as PortfolioFxRow[];
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    ownerName: row.ownerName,
    avatarUrl: row.avatarUrl || undefined,
    positions: positions.map(({ id: _id, snapshotId: _snapshotId, logoUrl, ...position }) => ({
      ...position,
      logoUrl: logoUrl || undefined
    })),
    cashBalances: cash.map(({ id: _id, snapshotId: _snapshotId, ...item }) => item),
    fxRates: fxRates.map(({ id: _id, snapshotId: _snapshotId, ...item }) => item),
    updatedAt: row.updatedAt
  };
}

function latestRows(connection: DatabaseSync) {
  return connection.prepare(`
    SELECT * FROM portfolio_snapshots WHERE status = 'published'
    ORDER BY datetime(publishedAt) DESC, rowid DESC LIMIT 2
  `).all() as PortfolioSnapshotRow[];
}

function writeSnapshotChildren(connection: DatabaseSync, snapshotId: string, draft: PortfolioDraft) {
  const insertPosition = connection.prepare(`
    INSERT INTO portfolio_positions (
      id, snapshotId, positionKey, symbol, name, assetType, market, sector, currency,
      quantity, averageCost, lastPrice, logoUrl, sortOrder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const position of draft.positions) {
    insertPosition.run(
      crypto.randomUUID(), snapshotId, position.positionKey, position.symbol, position.name, position.assetType,
      position.market, position.sector, position.currency, position.quantity, position.averageCost,
      position.lastPrice, position.logoUrl || null, position.sortOrder
    );
  }
  const insertCash = connection.prepare("INSERT INTO portfolio_cash_balances (id, snapshotId, currency, balance) VALUES (?, ?, ?, ?)");
  for (const cash of draft.cashBalances) insertCash.run(crypto.randomUUID(), snapshotId, cash.currency, cash.balance);
  const insertFx = connection.prepare("INSERT INTO portfolio_fx_rates (id, snapshotId, currency, rateToCny) VALUES (?, ?, ?, ?)");
  for (const fx of draft.fxRates) insertFx.run(crypto.randomUUID(), snapshotId, fx.currency, fx.rateToCny);
}

export function getPortfolioDraft(): PortfolioDraftResponse {
  const connection = database();
  const row = connection.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const latest = latestRows(connection)[0];
  return {
    draft: readSnapshot(connection, row),
    dirty: !latest || row.updatedAt > (latest.publishedAt || latest.updatedAt),
    latestPublishedAt: latest?.publishedAt || undefined
  };
}

export function savePortfolioDraft(input: PortfolioDraft): PortfolioDraftResponse {
  const connection = database();
  const current = connection.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const draft = normalizeDraft(input);
  const now = new Date().toISOString();
  withTransaction((transaction) => {
    transaction.prepare(`
      UPDATE portfolio_snapshots SET title = ?, subtitle = ?, ownerName = ?, avatarUrl = ?, updatedAt = ?
      WHERE id = ? AND status = 'draft'
    `).run(draft.title, draft.subtitle, draft.ownerName, draft.avatarUrl || null, now, current.id);
    transaction.prepare("DELETE FROM portfolio_positions WHERE snapshotId = ?").run(current.id);
    transaction.prepare("DELETE FROM portfolio_cash_balances WHERE snapshotId = ?").run(current.id);
    transaction.prepare("DELETE FROM portfolio_fx_rates WHERE snapshotId = ?").run(current.id);
    writeSnapshotChildren(transaction, current.id, draft);
  });
  return getPortfolioDraft();
}

export function publishPortfolioDraft() {
  const connection = database();
  const source = connection.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const draft = normalizeDraft(readSnapshot(connection, source));
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();
  withTransaction((transaction) => {
    transaction.prepare(`
      INSERT INTO portfolio_snapshots (
        id, status, title, subtitle, ownerName, avatarUrl, createdAt, updatedAt, publishedAt
      ) VALUES (?, 'published', ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, draft.title, draft.subtitle, draft.ownerName, draft.avatarUrl || null, now, now, now);
    writeSnapshotChildren(transaction, snapshotId, draft);
  });
  return getPortfolio("admin");
}

function sectorColor(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return sectorColors[Math.abs(hash) % sectorColors.length]!;
}

export function getPortfolio(accessLevel: PortfolioAccessLevel): PortfolioResponse {
  const connection = database();
  const [currentRow, previousRow] = latestRows(connection);
  if (!currentRow?.publishedAt) return { accessLevel, portfolio: null };
  const current = readSnapshot(connection, currentRow);
  const previous = previousRow ? readSnapshot(connection, previousRow) : null;
  const previousQuantities = new Map(previous?.positions.map((position) => [position.positionKey, position.quantity]) || []);
  const fxRates = new Map(current.fxRates.map((fx) => [fx.currency, fx.rateToCny]));
  const canViewSensitive = accessLevel !== "public";
  const positionMetrics = current.positions.map((position) => {
    const fx = fxRates.get(position.currency) || 1;
    const marketValueCny = position.quantity * position.lastPrice * fx;
    const costValueCny = position.quantity * position.averageCost * fx;
    return { position, marketValueCny, costValueCny, unrealizedPnlCny: marketValueCny - costValueCny };
  });
  const stockMarketValueCny = positionMetrics.reduce((sum, item) => sum + item.marketValueCny, 0);
  const stockCostValueCny = positionMetrics.reduce((sum, item) => sum + item.costValueCny, 0);
  const cashMetrics = current.cashBalances.map((cash) => ({ ...cash, marketValueCny: cash.balance * (fxRates.get(cash.currency) || 1) }));
  const cashMarketValueCny = cashMetrics.reduce((sum, item) => sum + item.marketValueCny, 0);
  const totalAssetsCny = stockMarketValueCny + cashMarketValueCny;
  const unrealizedPnlCny = positionMetrics.reduce((sum, item) => sum + item.unrealizedPnlCny, 0);
  const positions: PortfolioPositionView[] = positionMetrics.map(({ position, marketValueCny, costValueCny, unrealizedPnlCny }) => ({
    positionKey: position.positionKey,
    symbol: position.symbol,
    name: position.name,
    assetType: position.assetType,
    market: position.market,
    sector: position.sector,
    currency: position.currency,
    lastPrice: position.lastPrice,
    logoUrl: position.logoUrl,
    sortOrder: position.sortOrder,
    weightPercent: totalAssetsCny > 0 ? marketValueCny / totalAssetsCny * 100 : 0,
    returnPercent: costValueCny > 0 ? unrealizedPnlCny / costValueCny * 100 : null,
    ...(canViewSensitive ? {
      quantity: position.quantity,
      averageCost: position.averageCost,
      marketValueCny,
      unrealizedPnlCny,
      quantityChange: previous ? position.quantity - (previousQuantities.get(position.positionKey) || 0) : 0
    } : {})
  }));
  const sectorMap = new Map<string, { marketValueCny: number; positionCount: number }>();
  for (const item of positionMetrics) {
    const aggregate = sectorMap.get(item.position.sector) || { marketValueCny: 0, positionCount: 0 };
    aggregate.marketValueCny += item.marketValueCny;
    aggregate.positionCount += 1;
    sectorMap.set(item.position.sector, aggregate);
  }
  const sectors: PortfolioSectorView[] = [...sectorMap.entries()].map(([name, aggregate]) => ({
    name,
    color: sectorColor(name),
    weightPercent: totalAssetsCny > 0 ? aggregate.marketValueCny / totalAssetsCny * 100 : 0,
    positionCount: aggregate.positionCount,
    ...(canViewSensitive ? { marketValueCny: aggregate.marketValueCny } : {})
  })).sort((left, right) => right.weightPercent - left.weightPercent);
  const cash: PortfolioCashView[] = cashMetrics.filter((item) => item.balance > 0).map((item) => ({
    currency: item.currency,
    weightPercent: totalAssetsCny > 0 ? item.marketValueCny / totalAssetsCny * 100 : 0,
    ...(canViewSensitive ? { balance: item.balance, marketValueCny: item.marketValueCny } : {})
  }));
  const portfolio: PortfolioView = {
    snapshotId: current.id,
    title: current.title,
    subtitle: current.subtitle,
    ownerName: current.ownerName,
    avatarUrl: current.avatarUrl,
    publishedAt: currentRow.publishedAt,
    summary: {
      unrealizedReturnPercent: stockCostValueCny > 0 ? unrealizedPnlCny / stockCostValueCny * 100 : null,
      stockWeightPercent: totalAssetsCny > 0 ? stockMarketValueCny / totalAssetsCny * 100 : 0,
      cashWeightPercent: totalAssetsCny > 0 ? cashMarketValueCny / totalAssetsCny * 100 : 0,
      holdingCount: positions.length,
      sectorCount: sectors.length,
      ...(canViewSensitive ? { totalAssetsCny, stockMarketValueCny, cashMarketValueCny, unrealizedPnlCny } : {})
    },
    positions,
    sectors,
    cash
  };
  return { accessLevel, portfolio };
}
