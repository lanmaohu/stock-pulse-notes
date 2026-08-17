export interface ChatMessage {
  id: string;
  externalId: string;
  source: string;
  sender: string;
  content: string;
  messageAt: string;
  createdAt: string;
}

export type Platform = "bilibili" | "douyin" | "xiaohongshu";
export type PlatformAccountStatus = "connected" | "needs_reauth" | "checking" | "error";

export interface PlatformAccount {
  id: string;
  platform: Platform;
  externalUserId: string;
  displayName: string;
  avatarUrl?: string;
  status: PlatformAccountStatus;
  lastCheckedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Creator {
  id: string;
  platform: Platform;
  externalId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  profileUrl: string;
  enabled: boolean;
  lastCollectedAt?: string;
  lastCollectionStatus?: "success" | "error";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentCreatorOption {
  id: string;
  name: string;
  platform: Platform;
}

export interface CreatorCandidate {
  platform: Platform;
  externalId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  profileUrl: string;
  followerCount?: number;
}

export type ContentStatus = "ready" | "metadata_only" | "error";
export type AnalysisStatus = "pending" | "running" | "success" | "error";

export interface ContentItem {
  id: string;
  platform: Platform;
  externalId: string;
  creatorId: string;
  creatorExternalId: string;
  creatorName: string;
  contentType: "video" | "note";
  title: string;
  description: string;
  tags: string[];
  sourceUrl: string;
  coverUrl?: string;
  publishedAt: string;
  collectedAt: string;
  transcript: string;
  transcriptSource: "subtitle" | "metadata";
  status: ContentStatus;
  analysisStatus: AnalysisStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type ViewStance = "bullish" | "bearish" | "neutral" | "mixed" | "watch";
export type ViewConfidence = "high" | "medium" | "low";

export interface ContentStockView {
  id: string;
  contentId: string;
  platform: Platform;
  creatorId: string;
  creatorExternalId: string;
  creatorName: string;
  title: string;
  sourceUrl: string;
  publishedAt: string;
  collectedAt: string;
  symbols: string[];
  companies: string[];
  stance: ViewStance;
  coreView: string;
  evidence: string[];
  risks: string[];
  confidence: ViewConfidence;
  sourceSnippet: string;
  model: string;
  createdAt: string;
}

export interface ContentInsight {
  content: ContentItem;
  views: ContentStockView[];
}

export type CollectionRunTrigger = "manual" | "scheduled" | "subscription";
export type CollectionRunStatus = "queued" | "running" | "success" | "partial" | "error";

export interface CollectionRunItem {
  id: string;
  runId: string;
  creatorId: string;
  creatorName: string;
  status: "queued" | "running" | "success" | "error";
  discoveredCount: number;
  newContentCount: number;
  analyzedCount: number;
  errorCode?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CollectionRun {
  id: string;
  trigger: CollectionRunTrigger;
  status: CollectionRunStatus;
  scheduledFor?: string;
  creatorCount: number;
  discoveredCount: number;
  newContentCount: number;
  analyzedCount: number;
  errorCount: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  items: CollectionRunItem[];
}

export interface CollectionSettings {
  enabled: boolean;
  localTime: string;
  timezone: "Asia/Shanghai";
  maxVideosPerCreator: number;
  updatedAt: string;
}

export type PortfolioAccessLevel = "public" | "viewer" | "admin";
export type PortfolioCurrency = "CNY" | "HKD" | "USD";
export type PortfolioAssetType = "stock" | "etf";

export interface PortfolioFxRate {
  currency: PortfolioCurrency;
  rateToCny: number;
}

export interface PortfolioCashBalance {
  currency: PortfolioCurrency;
  balance: number;
}

export interface PortfolioDraftPosition {
  positionKey: string;
  symbol: string;
  name: string;
  assetType: PortfolioAssetType;
  market: string;
  sector: string;
  currency: PortfolioCurrency;
  quantity: number;
  averageCost: number;
  lastPrice: number;
  logoUrl?: string;
  sortOrder: number;
}

export interface PortfolioDraft {
  id: string;
  title: string;
  subtitle: string;
  ownerName: string;
  avatarUrl?: string;
  positions: PortfolioDraftPosition[];
  cashBalances: PortfolioCashBalance[];
  fxRates: PortfolioFxRate[];
  updatedAt: string;
}

export interface PortfolioPositionView {
  positionKey: string;
  symbol: string;
  name: string;
  assetType: PortfolioAssetType;
  market: string;
  sector: string;
  currency: PortfolioCurrency;
  lastPrice: number;
  logoUrl?: string;
  sortOrder: number;
  weightPercent: number;
  returnPercent: number | null;
  quantity?: number;
  averageCost?: number;
  marketValueCny?: number;
  unrealizedPnlCny?: number;
  quantityChange?: number;
}

export interface PortfolioSectorView {
  name: string;
  color: string;
  weightPercent: number;
  positionCount: number;
  marketValueCny?: number;
}

export interface PortfolioCashView {
  currency: PortfolioCurrency;
  weightPercent: number;
  balance?: number;
  marketValueCny?: number;
}

export interface PortfolioSummary {
  unrealizedReturnPercent: number | null;
  stockWeightPercent: number;
  cashWeightPercent: number;
  holdingCount: number;
  sectorCount: number;
  totalAssetsCny?: number;
  stockMarketValueCny?: number;
  cashMarketValueCny?: number;
  unrealizedPnlCny?: number;
}

export interface PortfolioView {
  snapshotId: string;
  title: string;
  subtitle: string;
  ownerName: string;
  avatarUrl?: string;
  publishedAt: string;
  summary: PortfolioSummary;
  positions: PortfolioPositionView[];
  sectors: PortfolioSectorView[];
  cash: PortfolioCashView[];
}

export interface PortfolioResponse {
  accessLevel: PortfolioAccessLevel;
  portfolio: PortfolioView | null;
}

export interface PortfolioSessionResponse {
  accessLevel: PortfolioAccessLevel;
}

export interface PortfolioDraftResponse {
  draft: PortfolioDraft;
  dirty: boolean;
  latestPublishedAt?: string;
}

export type BilibiliQrStatus = "waiting" | "scanned" | "confirmed" | "expired" | "error";

export interface BilibiliQrSession {
  sessionId: string;
  qrImageDataUrl?: string;
  status: BilibiliQrStatus;
  expiresAt: string;
  account?: PlatformAccount;
  error?: string;
}

export interface LoginResponse {
  token: string;
}

export interface AuthSessionResponse {
  authenticated: boolean;
}

export interface PlatformAccountsResponse {
  accounts: PlatformAccount[];
}

export interface CreatorSearchResponse {
  candidates: CreatorCandidate[];
}

export interface CreatorsResponse {
  creators: Creator[];
}

export interface ContentCreatorOptionsResponse {
  creators: ContentCreatorOption[];
}

export type ContentInsightsPageSize = 10 | 20 | 50;

export interface ContentInsightsPagination {
  page: number;
  pageSize: ContentInsightsPageSize;
  totalItems: number;
  totalPages: number;
}

export interface ContentInsightsSummary {
  contentCount: number;
  viewCount: number;
  targetCount: number;
}

export interface ContentInsightsResponse {
  insights: ContentInsight[];
  pagination: ContentInsightsPagination;
  summary: ContentInsightsSummary;
  nextCursor?: string;
}

export interface CollectionRunsResponse {
  runs: CollectionRun[];
}

export interface CollectionSettingsResponse {
  settings: CollectionSettings;
}

export interface HealthResponse {
  ok: boolean;
  service: "stockpulse";
  storage: "sqlite";
}

export interface LiveHealthResponse {
  ok: true;
  service: "stockpulse";
  release: string;
  uptimeSeconds: number;
}

export interface ReadinessHealthResponse {
  ok: boolean;
  service: "stockpulse";
  release: string;
  checks: {
    database: "ok" | "error";
    schema: "ok" | "error";
    worker: "ok" | "missing" | "stale";
    backup: "ok" | "missing" | "stale";
  };
  queue: {
    queued: number;
    running: number;
    oldestQueuedAt?: string;
    expiredLeases: number;
  };
  latestBackupAt?: string;
}

export interface HermesMessageInput {
  externalId?: string;
  source?: string;
  sender: string;
  content: string;
  messageAt?: string;
}

export interface HermesWebhookInput {
  messages?: HermesMessageInput[];
  externalId?: string;
  source?: string;
  sender?: string;
  content?: string;
  messageAt?: string;
}
