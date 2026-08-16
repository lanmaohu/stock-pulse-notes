import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./config.js";
import type {
  BilibiliCreator,
  BilibiliVideo,
  ChatMessage,
  CollectionRun,
  CollectionRunItem,
  CollectionRunStatus,
  CollectionRunTrigger,
  CollectionSettings,
  ContentCreatorOption,
  ContentInsightsPageSize,
  ContentInsightsResponse,
  ContentItem,
  ContentStockView,
  Creator,
  CreatorCandidate,
  DailySummary,
  HermesMessageInput,
  Note,
  Platform,
  PlatformAccount,
  PlatformAccountStatus,
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
  PortfolioView,
  ResearchSuggestion,
  VideoStockView
} from "../shared/types.js";

const dbPath = databasePath();
const dataDir = path.dirname(dbPath);
const legacyNotesPath = path.join(dataDir, "notes.json");
const currentSchemaMigration = "2026-08-stability-v1";

let db: DatabaseSync | null = null;
let schemaReady = false;

type NoteRow = Omit<Note, "tags" | "pinned"> & { tags: string; pinned: number };
type ChatMessageRow = ChatMessage;
type DailySummaryRow = Omit<
  DailySummary,
  "coreViews" | "insights" | "investmentThemes" | "evidence" | "risks" | "questions" | "nextSteps"
> & {
  coreViews: string;
  insights: string;
  investmentThemes: string;
  evidence: string;
  risks: string;
  questions: string;
  nextSteps: string;
};
type ResearchSuggestionRow = Omit<ResearchSuggestion, "risks" | "validationSteps"> & {
  risks: string;
  validationSteps: string;
};
type BilibiliCreatorRow = Omit<BilibiliCreator, "enabled"> & { enabled: number };
type BilibiliVideoRow = Omit<BilibiliVideo, "tags" | "aid" | "cid" | "error"> & {
  tags: string;
  aid: string | null;
  cid: string | null;
  error: string | null;
};
type VideoStockViewRow = Omit<VideoStockView, "symbols" | "companies" | "evidence" | "risks"> & {
  symbols: string;
  companies: string;
  evidence: string;
  risks: string;
};
type PlatformAccountRow = Omit<PlatformAccount, "avatarUrl" | "lastCheckedAt" | "error"> & {
  avatarUrl: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  credentialsCiphertext: string;
};
type CreatorRow = Omit<
  Creator,
  "enabled" | "handle" | "avatarUrl" | "lastCollectedAt" | "lastCollectionStatus" | "lastError"
> & {
  enabled: number;
  handle: string | null;
  avatarUrl: string | null;
  lastCollectedAt: string | null;
  lastCollectionStatus: "success" | "error" | null;
  lastError: string | null;
};
type ContentItemRow = Omit<ContentItem, "tags" | "coverUrl" | "error"> & {
  tags: string;
  coverUrl: string | null;
  error: string | null;
};
type ContentStockViewRow = Omit<ContentStockView, "symbols" | "companies" | "evidence" | "risks"> & {
  symbols: string;
  companies: string;
  evidence: string;
  risks: string;
};
type CollectionRunRow = Omit<CollectionRun, "items" | "scheduledFor" | "error" | "startedAt" | "completedAt"> & {
  scheduledFor: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
};
type CollectionRunItemRow = Omit<
  CollectionRunItem,
  "errorCode" | "error" | "startedAt" | "completedAt"
> & {
  errorCode: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
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

export interface SummaryInput {
  date: string;
  coreViews: string[];
  insights: string[];
  investmentThemes: string[];
  evidence: string[];
  risks: string[];
  questions: string[];
  nextSteps: string[];
  disclaimer: string;
  sourceMessageCount: number;
  sourceNoteCount: number;
  sourceVideoViewCount?: number;
  model: string;
}

export interface SuggestionInput {
  title: string;
  thesis: string;
  rationale: string;
  risks: string[];
  validationSteps: string[];
}

export interface VideoInput {
  bvid: string;
  aid?: string;
  cid?: string;
  creatorMid: string;
  creatorName: string;
  title: string;
  description: string;
  tags: string[];
  videoUrl: string;
  publishedAt: string;
  transcript: string;
  transcriptSource: "subtitle" | "metadata";
  status: BilibiliVideo["status"];
  error?: string;
}

export interface VideoStockViewInput {
  symbols: string[];
  companies: string[];
  stance: VideoStockView["stance"];
  coreView: string;
  evidence: string[];
  risks: string[];
  confidence: VideoStockView["confidence"];
  sourceSnippet: string;
  model: string;
}

export interface ContentInput {
  platform: Platform;
  externalId: string;
  creatorId: string;
  creatorExternalId: string;
  creatorName: string;
  contentType: ContentItem["contentType"];
  title: string;
  description: string;
  tags: string[];
  sourceUrl: string;
  coverUrl?: string;
  publishedAt: string;
  transcript: string;
  transcriptSource: ContentItem["transcriptSource"];
  status: ContentItem["status"];
  error?: string;
}

export interface ContentStockViewInput {
  symbols: string[];
  companies: string[];
  stance: ContentStockView["stance"];
  coreView: string;
  evidence: string[];
  risks: string[];
  confidence: ContentStockView["confidence"];
  sourceSnippet: string;
  model: string;
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toNote(row: NoteRow): Note {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    tags: jsonArray(row.tags)
  };
}

function toDailySummary(row: DailySummaryRow): DailySummary {
  return {
    ...row,
    coreViews: jsonArray(row.coreViews),
    insights: jsonArray(row.insights),
    investmentThemes: jsonArray(row.investmentThemes),
    evidence: jsonArray(row.evidence),
    risks: jsonArray(row.risks),
    questions: jsonArray(row.questions),
    nextSteps: jsonArray(row.nextSteps)
  };
}

function toResearchSuggestion(row: ResearchSuggestionRow): ResearchSuggestion {
  return {
    ...row,
    risks: jsonArray(row.risks),
    validationSteps: jsonArray(row.validationSteps)
  };
}

function toBilibiliCreator(row: BilibiliCreatorRow): BilibiliCreator {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    lastCollectedAt: row.lastCollectedAt || undefined
  };
}

function toBilibiliVideo(row: BilibiliVideoRow): BilibiliVideo {
  return {
    ...row,
    aid: row.aid || undefined,
    cid: row.cid || undefined,
    error: row.error || undefined,
    tags: jsonArray(row.tags)
  };
}

function toVideoStockView(row: VideoStockViewRow): VideoStockView {
  return {
    ...row,
    symbols: jsonArray(row.symbols),
    companies: jsonArray(row.companies),
    evidence: jsonArray(row.evidence),
    risks: jsonArray(row.risks)
  };
}

function toPlatformAccount(row: PlatformAccountRow): PlatformAccount {
  const { credentialsCiphertext: _credential, ...safe } = row;
  return {
    ...safe,
    avatarUrl: row.avatarUrl || undefined,
    lastCheckedAt: row.lastCheckedAt || undefined,
    error: row.error || undefined
  };
}

function toCreator(row: CreatorRow): Creator {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    handle: row.handle || undefined,
    avatarUrl: row.avatarUrl || undefined,
    lastCollectedAt: row.lastCollectedAt || undefined,
    lastCollectionStatus: row.lastCollectionStatus || undefined,
    lastError: row.lastError || undefined
  };
}

function toContentItem(row: ContentItemRow): ContentItem {
  return {
    ...row,
    tags: jsonArray(row.tags),
    coverUrl: row.coverUrl || undefined,
    error: row.error || undefined
  };
}

function toContentStockView(row: ContentStockViewRow): ContentStockView {
  return {
    ...row,
    symbols: jsonArray(row.symbols),
    companies: jsonArray(row.companies),
    evidence: jsonArray(row.evidence),
    risks: jsonArray(row.risks)
  };
}

function toCollectionRunItem(row: CollectionRunItemRow): CollectionRunItem {
  return {
    ...row,
    errorCode: row.errorCode || undefined,
    error: row.error || undefined,
    startedAt: row.startedAt || undefined,
    completedAt: row.completedAt || undefined
  };
}

function toCollectionRun(row: CollectionRunRow, items: CollectionRunItem[] = []): CollectionRun {
  const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...publicRow } = row;
  return {
    ...publicRow,
    scheduledFor: row.scheduledFor || undefined,
    error: row.error || undefined,
    startedAt: row.startedAt || undefined,
    completedAt: row.completedAt || undefined,
    items
  };
}

function database() {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  return db;
}

function migrate() {
  const conn = database();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      externalId TEXT NOT NULL,
      source TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      messageAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(source, externalId)
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      coreViews TEXT NOT NULL,
      insights TEXT NOT NULL,
      investmentThemes TEXT NOT NULL,
      evidence TEXT NOT NULL,
      risks TEXT NOT NULL,
      questions TEXT NOT NULL,
      nextSteps TEXT NOT NULL,
      disclaimer TEXT NOT NULL,
      sourceMessageCount INTEGER NOT NULL,
      sourceNoteCount INTEGER NOT NULL,
      sourceVideoViewCount INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_suggestions (
      id TEXT PRIMARY KEY,
      summaryId TEXT NOT NULL,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      rationale TEXT NOT NULL,
      risks TEXT NOT NULL,
      validationSteps TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(summaryId) REFERENCES daily_summaries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_runs (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      promptTokens INTEGER,
      completionTokens INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bilibili_creators (
      mid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastCollectedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bilibili_videos (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL UNIQUE,
      aid TEXT,
      cid TEXT,
      creatorMid TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      tags TEXT NOT NULL,
      videoUrl TEXT NOT NULL,
      publishedAt TEXT NOT NULL,
      collectedAt TEXT NOT NULL,
      transcript TEXT NOT NULL,
      transcriptSource TEXT NOT NULL,
      status TEXT NOT NULL,
      summaryStatus TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_stock_views (
      id TEXT PRIMARY KEY,
      videoId TEXT NOT NULL,
      bvid TEXT NOT NULL,
      creatorMid TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      title TEXT NOT NULL,
      videoUrl TEXT NOT NULL,
      publishedAt TEXT NOT NULL,
      symbols TEXT NOT NULL,
      companies TEXT NOT NULL,
      stance TEXT NOT NULL,
      coreView TEXT NOT NULL,
      evidence TEXT NOT NULL,
      risks TEXT NOT NULL,
      confidence TEXT NOT NULL,
      sourceSnippet TEXT NOT NULL,
      model TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(videoId) REFERENCES bilibili_videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL UNIQUE,
      externalUserId TEXT NOT NULL,
      displayName TEXT NOT NULL,
      avatarUrl TEXT,
      status TEXT NOT NULL,
      credentialsCiphertext TEXT NOT NULL,
      lastCheckedAt TEXT,
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      externalId TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT,
      avatarUrl TEXT,
      profileUrl TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastCollectedAt TEXT,
      lastCollectionStatus TEXT,
      lastError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(platform, externalId)
    );

    CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      externalId TEXT NOT NULL,
      creatorId TEXT NOT NULL,
      creatorExternalId TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      contentType TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      tags TEXT NOT NULL,
      sourceUrl TEXT NOT NULL,
      coverUrl TEXT,
      publishedAt TEXT NOT NULL,
      collectedAt TEXT NOT NULL,
      transcript TEXT NOT NULL,
      transcriptSource TEXT NOT NULL,
      status TEXT NOT NULL,
      analysisStatus TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(platform, externalId),
      FOREIGN KEY(creatorId) REFERENCES creators(id)
    );

    CREATE TABLE IF NOT EXISTS content_stock_views (
      id TEXT PRIMARY KEY,
      contentId TEXT NOT NULL,
      platform TEXT NOT NULL,
      creatorId TEXT NOT NULL,
      creatorExternalId TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      title TEXT NOT NULL,
      sourceUrl TEXT NOT NULL,
      publishedAt TEXT NOT NULL,
      collectedAt TEXT NOT NULL,
      symbols TEXT NOT NULL,
      companies TEXT NOT NULL,
      stance TEXT NOT NULL,
      coreView TEXT NOT NULL,
      evidence TEXT NOT NULL,
      risks TEXT NOT NULL,
      confidence TEXT NOT NULL,
      sourceSnippet TEXT NOT NULL,
      model TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(contentId) REFERENCES content_items(id) ON DELETE CASCADE,
      FOREIGN KEY(creatorId) REFERENCES creators(id)
    );

    CREATE TABLE IF NOT EXISTS collection_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduledFor TEXT,
      creatorCount INTEGER NOT NULL DEFAULT 0,
      discoveredCount INTEGER NOT NULL DEFAULT 0,
      newContentCount INTEGER NOT NULL DEFAULT 0,
      analyzedCount INTEGER NOT NULL DEFAULT 0,
      errorCount INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      startedAt TEXT,
      completedAt TEXT,
      leaseOwner TEXT,
      leaseExpiresAt INTEGER,
      createdAt TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_runs_scheduled
      ON collection_runs(trigger, scheduledFor)
      WHERE trigger = 'scheduled' AND scheduledFor IS NOT NULL;

    CREATE TABLE IF NOT EXISTS collection_run_items (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      creatorId TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      status TEXT NOT NULL,
      discoveredCount INTEGER NOT NULL DEFAULT 0,
      newContentCount INTEGER NOT NULL DEFAULT 0,
      analyzedCount INTEGER NOT NULL DEFAULT 0,
      errorCode TEXT,
      error TEXT,
      startedAt TEXT,
      completedAt TEXT,
      FOREIGN KEY(runId) REFERENCES collection_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(creatorId) REFERENCES creators(id)
    );

    CREATE TABLE IF NOT EXISTS collection_settings (
      id TEXT PRIMARY KEY CHECK(id = 'owner'),
      enabled INTEGER NOT NULL,
      localTime TEXT NOT NULL,
      timezone TEXT NOT NULL,
      maxVideosPerCreator INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      scope TEXT NOT NULL,
      address TEXT NOT NULL,
      attemptCount INTEGER NOT NULL,
      resetAt INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY(scope, address)
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      ownerName TEXT NOT NULL,
      avatarUrl TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      publishedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS portfolio_positions (
      id TEXT PRIMARY KEY,
      snapshotId TEXT NOT NULL,
      positionKey TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      assetType TEXT NOT NULL CHECK(assetType IN ('stock', 'etf')),
      market TEXT NOT NULL,
      sector TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CNY', 'HKD', 'USD')),
      quantity REAL NOT NULL CHECK(quantity >= 0),
      averageCost REAL NOT NULL CHECK(averageCost >= 0),
      lastPrice REAL NOT NULL CHECK(lastPrice >= 0),
      logoUrl TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      UNIQUE(snapshotId, positionKey),
      UNIQUE(snapshotId, market, symbol),
      FOREIGN KEY(snapshotId) REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio_cash_balances (
      id TEXT PRIMARY KEY,
      snapshotId TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CNY', 'HKD', 'USD')),
      balance REAL NOT NULL CHECK(balance >= 0),
      UNIQUE(snapshotId, currency),
      FOREIGN KEY(snapshotId) REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio_fx_rates (
      id TEXT PRIMARY KEY,
      snapshotId TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CNY', 'HKD', 'USD')),
      rateToCny REAL NOT NULL CHECK(rateToCny > 0),
      UNIQUE(snapshotId, currency),
      FOREIGN KEY(snapshotId) REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_content_items_collected ON content_items(collectedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_content_items_published
      ON content_items(publishedAt DESC, collectedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_content_items_creator ON content_items(creatorId, publishedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_content_views_content ON content_stock_views(contentId);
    CREATE INDEX IF NOT EXISTS idx_run_items_run ON collection_run_items(runId);
    CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_reset ON auth_login_attempts(resetAt);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_single_draft
      ON portfolio_snapshots(status) WHERE status = 'draft';
    CREATE INDEX IF NOT EXISTS idx_portfolio_published
      ON portfolio_snapshots(publishedAt DESC) WHERE status = 'published';
    CREATE INDEX IF NOT EXISTS idx_portfolio_positions_snapshot
      ON portfolio_positions(snapshotId, sortOrder);
  `);

  const summaryColumns = conn.prepare("PRAGMA table_info(daily_summaries)").all() as Array<{ name: string }>;
  if (!summaryColumns.some((column) => column.name === "sourceVideoViewCount")) {
    conn.exec("ALTER TABLE daily_summaries ADD COLUMN sourceVideoViewCount INTEGER NOT NULL DEFAULT 0");
  }

  const runColumns = conn.prepare("PRAGMA table_info(collection_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "leaseOwner")) {
    conn.exec("ALTER TABLE collection_runs ADD COLUMN leaseOwner TEXT");
  }
  if (!runColumns.some((column) => column.name === "leaseExpiresAt")) {
    conn.exec("ALTER TABLE collection_runs ADD COLUMN leaseExpiresAt INTEGER");
  }

  const noteCount = conn.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number } | undefined;
  if (noteCount?.count === 0 && fs.existsSync(legacyNotesPath)) {
    const raw = fs.readFileSync(legacyNotesPath, "utf8");
    const legacy = JSON.parse(raw) as Note[];
    const insert = conn.prepare(`
      INSERT OR IGNORE INTO notes (id, title, content, tags, pinned, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const note of legacy) {
      insert.run(
        note.id,
        note.title || "未命名笔记",
        note.content || "",
        JSON.stringify(Array.isArray(note.tags) ? note.tags : []),
        note.pinned ? 1 : 0,
        note.createdAt,
        note.updatedAt
      );
    }
  }

  const configuredTime = /^\d{2}:\d{2}$/.test(process.env.BILIBILI_COLLECT_CRON_TIME || "")
    ? process.env.BILIBILI_COLLECT_CRON_TIME!
    : "07:30";
  conn
    .prepare(
      `INSERT OR IGNORE INTO collection_settings
        (id, enabled, localTime, timezone, maxVideosPerCreator, updatedAt)
       VALUES ('owner', 1, ?, 'Asia/Shanghai', 5, ?)`
    )
    .run(configuredTime, new Date().toISOString());
  const portfolioDraft = conn.prepare("SELECT id FROM portfolio_snapshots WHERE status = 'draft'").get() as { id: string } | undefined;
  if (!portfolioDraft) {
    const now = new Date().toISOString();
    const snapshotId = crypto.randomUUID();
    conn.exec("BEGIN");
    try {
      conn.prepare(`
        INSERT INTO portfolio_snapshots (
          id, status, title, subtitle, ownerName, avatarUrl, createdAt, updatedAt, publishedAt
        ) VALUES (?, 'draft', ?, ?, ?, NULL, ?, ?, NULL)
      `).run(snapshotId, "我的持仓全景图", "按板块分类的个人资产配置", "Stockpulse", now, now);
      const insertCash = conn.prepare(`
        INSERT INTO portfolio_cash_balances (id, snapshotId, currency, balance) VALUES (?, ?, ?, 0)
      `);
      const insertFx = conn.prepare(`
        INSERT INTO portfolio_fx_rates (id, snapshotId, currency, rateToCny) VALUES (?, ?, ?, ?)
      `);
      for (const currency of ["CNY", "HKD", "USD"] as PortfolioCurrency[]) {
        insertCash.run(crypto.randomUUID(), snapshotId, currency);
        insertFx.run(crypto.randomUUID(), snapshotId, currency, currency === "CNY" ? 1 : 1);
      }
      conn.exec("COMMIT");
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  }
  conn.exec("PRAGMA optimize");
  migrateLegacyBilibili(conn);
  conn.prepare("INSERT OR IGNORE INTO schema_migrations (name, appliedAt) VALUES (?, ?)")
    .run(currentSchemaMigration, new Date().toISOString());
}

function migrateLegacyBilibili(conn: DatabaseSync) {
  const migrationName = "2026-07-media-monitor-v1";
  if (conn.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migrationName)) {
    return;
  }

  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    const creatorIds = new Map<string, string>();
    const legacyCreators = conn.prepare("SELECT * FROM bilibili_creators").all() as BilibiliCreatorRow[];
    const legacyVideos = conn.prepare("SELECT * FROM bilibili_videos ORDER BY datetime(publishedAt) ASC").all() as BilibiliVideoRow[];

    const ensureCreator = (externalId: string, name: string, lastCollectedAt?: string) => {
      const cached = creatorIds.get(externalId);
      if (cached) {
        return cached;
      }
      const existing = conn
        .prepare("SELECT id FROM creators WHERE platform = 'bilibili' AND externalId = ?")
        .get(externalId) as { id: string } | undefined;
      const id = existing?.id || crypto.randomUUID();
      conn
        .prepare(
          `INSERT OR IGNORE INTO creators
            (id, platform, externalId, name, handle, avatarUrl, profileUrl, enabled, lastCollectedAt,
             lastCollectionStatus, lastError, createdAt, updatedAt)
           VALUES (?, 'bilibili', ?, ?, NULL, NULL, ?, 1, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          externalId,
          name || `UP ${externalId}`,
          `https://space.bilibili.com/${externalId}`,
          lastCollectedAt || null,
          lastCollectedAt ? "success" : null,
          now,
          now
        );
      creatorIds.set(externalId, id);
      return id;
    };

    for (const creator of legacyCreators) {
      ensureCreator(creator.mid, creator.name, creator.lastCollectedAt);
    }

    const insertContent = conn.prepare(`
      INSERT OR IGNORE INTO content_items (
        id, platform, externalId, creatorId, creatorExternalId, creatorName, contentType, title, description,
        tags, sourceUrl, coverUrl, publishedAt, collectedAt, transcript, transcriptSource, status,
        analysisStatus, error, createdAt, updatedAt
      ) VALUES (?, 'bilibili', ?, ?, ?, ?, 'video', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const video of legacyVideos) {
      const creatorId = ensureCreator(video.creatorMid, video.creatorName, video.collectedAt);
      const status = video.status === "ready" || video.status === "error" ? video.status : "metadata_only";
      const analysisStatus =
        video.summaryStatus === "success" || video.summaryStatus === "error" ? video.summaryStatus : "pending";
      insertContent.run(
        video.id,
        video.bvid,
        creatorId,
        video.creatorMid,
        video.creatorName,
        video.title,
        video.description,
        video.tags,
        video.videoUrl,
        video.publishedAt,
        video.collectedAt,
        video.transcript,
        video.transcriptSource,
        status,
        analysisStatus,
        video.error,
        video.createdAt,
        video.updatedAt
      );
    }

    const legacyViews = conn.prepare("SELECT * FROM video_stock_views").all() as VideoStockViewRow[];
    const insertView = conn.prepare(`
      INSERT OR IGNORE INTO content_stock_views (
        id, contentId, platform, creatorId, creatorExternalId, creatorName, title, sourceUrl, publishedAt,
        collectedAt, symbols, companies, stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt
      ) VALUES (?, ?, 'bilibili', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const view of legacyViews) {
      const content = conn
        .prepare("SELECT creatorId, collectedAt FROM content_items WHERE id = ?")
        .get(view.videoId) as { creatorId: string; collectedAt: string } | undefined;
      if (!content) {
        continue;
      }
      insertView.run(
        view.id,
        view.videoId,
        content.creatorId,
        view.creatorMid,
        view.creatorName,
        view.title,
        view.videoUrl,
        view.publishedAt,
        content.collectedAt,
        view.symbols,
        view.companies,
        view.stance,
        view.coreView,
        view.evidence,
        view.risks,
        view.confidence,
        view.sourceSnippet,
        view.model,
        view.createdAt
      );
    }

    conn.prepare("INSERT INTO schema_migrations (name, appliedAt) VALUES (?, ?)").run(migrationName, now);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export async function ensureDatabase() {
  await fsp.mkdir(dataDir, { recursive: true });
  if (!schemaReady) {
    migrate();
    schemaReady = true;
  }
}

export async function verifyDatabaseSchema() {
  await fsp.mkdir(dataDir, { recursive: true });
  const row = database()
    .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('content_items', 'collection_runs', 'portfolio_snapshots')")
    .get() as { count: number } | undefined;
  const version = database().prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(currentSchemaMigration);
  if (row?.count !== 3 || !version) throw new Error("Database schema is not current. Run npm run migrate first.");
  schemaReady = true;
}

export function databaseIsHealthy() {
  try {
    return (database().prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export function assertLoginAllowed(scope: string, address: string, now = Date.now()) {
  const conn = database();
  conn.prepare("DELETE FROM auth_login_attempts WHERE resetAt <= ?").run(now);
  const row = conn
    .prepare("SELECT attemptCount, resetAt FROM auth_login_attempts WHERE scope = ? AND address = ?")
    .get(scope, address) as { attemptCount: number; resetAt: number } | undefined;
  return !row || row.resetAt <= now || row.attemptCount < 5;
}

export function recordLoginFailure(scope: string, address: string, resetAt: number) {
  database().prepare(`
    INSERT INTO auth_login_attempts (scope, address, attemptCount, resetAt, updatedAt)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(scope, address) DO UPDATE SET
      attemptCount = CASE WHEN auth_login_attempts.resetAt <= ? THEN 1 ELSE auth_login_attempts.attemptCount + 1 END,
      resetAt = CASE WHEN auth_login_attempts.resetAt <= ? THEN excluded.resetAt ELSE auth_login_attempts.resetAt END,
      updatedAt = excluded.updatedAt
  `).run(scope, address, resetAt, new Date().toISOString(), Date.now(), Date.now());
}

export function clearLoginFailures(scope: string, address: string) {
  database().prepare("DELETE FROM auth_login_attempts WHERE scope = ? AND address = ?").run(scope, address);
}

export function listNotes(): Note[] {
  const rows = database()
    .prepare("SELECT * FROM notes ORDER BY pinned DESC, datetime(updatedAt) DESC")
    .all() as NoteRow[];
  return rows.map(toNote);
}

export function createNote(input: Required<Pick<Note, "title" | "content" | "tags" | "pinned">>): Note {
  const note: Note = {
    id: crypto.randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  database()
    .prepare("INSERT INTO notes (id, title, content, tags, pinned, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(note.id, note.title, note.content, JSON.stringify(note.tags), note.pinned ? 1 : 0, note.createdAt, note.updatedAt);
  return note;
}

export function updateNote(id: string, input: Required<Pick<Note, "title" | "content" | "tags" | "pinned">>): Note | null {
  const current = database().prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  if (!current) {
    return null;
  }
  const updated: Note = {
    ...toNote(current),
    ...input,
    updatedAt: new Date().toISOString()
  };
  database()
    .prepare("UPDATE notes SET title = ?, content = ?, tags = ?, pinned = ?, updatedAt = ? WHERE id = ?")
    .run(updated.title, updated.content, JSON.stringify(updated.tags), updated.pinned ? 1 : 0, updated.updatedAt, id);
  return updated;
}

export function deleteNote(id: string) {
  return Number(database().prepare("DELETE FROM notes WHERE id = ?").run(id).changes) > 0;
}

export function insertChatMessages(inputs: HermesMessageInput[]): ChatMessage[] {
  const now = new Date().toISOString();
  const inserted: ChatMessage[] = [];
  const stmt = database().prepare(`
    INSERT OR IGNORE INTO chat_messages (id, externalId, source, sender, content, messageAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const input of inputs) {
    const source = (input.source || "hermes").slice(0, 40);
    const content = input.content.trim();
    if (!content) {
      continue;
    }
    const messageAt = input.messageAt ? new Date(input.messageAt).toISOString() : now;
    const externalId =
      input.externalId ||
      crypto.createHash("sha256").update(`${source}:${input.sender}:${messageAt}:${content}`).digest("hex");
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      externalId,
      source,
      sender: input.sender.trim().slice(0, 80) || "unknown",
      content: content.slice(0, 20000),
      messageAt,
      createdAt: now
    };
    const result = stmt.run(
      message.id,
      message.externalId,
      message.source,
      message.sender,
      message.content,
      message.messageAt,
      message.createdAt
    );
    if (Number(result.changes) > 0) {
      inserted.push(message);
    }
  }

  return inserted;
}

export function listChatMessages(limit = 200): ChatMessage[] {
  return database()
    .prepare("SELECT * FROM chat_messages ORDER BY datetime(messageAt) DESC LIMIT ?")
    .all(limit) as unknown as ChatMessageRow[];
}

export function getDailyContext(date: string) {
  const start = new Date(`${date}T00:00:00.000+08:00`).toISOString();
  const end = new Date(`${date}T23:59:59.999+08:00`).toISOString();
  const messages = database()
    .prepare("SELECT * FROM chat_messages WHERE messageAt BETWEEN ? AND ? ORDER BY datetime(messageAt) ASC")
    .all(start, end) as unknown as ChatMessageRow[];
  const notes = database()
    .prepare("SELECT * FROM notes WHERE updatedAt BETWEEN ? AND ? ORDER BY datetime(updatedAt) ASC")
    .all(start, end) as NoteRow[];
  const videoViews = database()
    .prepare("SELECT * FROM video_stock_views WHERE publishedAt BETWEEN ? AND ? ORDER BY datetime(publishedAt) ASC")
    .all(start, end) as VideoStockViewRow[];
  return { messages, notes: notes.map(toNote), videoViews: videoViews.map(toVideoStockView) };
}

export function getSummaryByDate(date: string): DailySummary | null {
  const row = database().prepare("SELECT * FROM daily_summaries WHERE date = ?").get(date) as DailySummaryRow | undefined;
  return row ? toDailySummary(row) : null;
}

export function listDailySummaries(limit = 30): DailySummary[] {
  const rows = database()
    .prepare("SELECT * FROM daily_summaries ORDER BY date DESC LIMIT ?")
    .all(limit) as DailySummaryRow[];
  return rows.map(toDailySummary);
}

export function saveDailySummary(input: SummaryInput, suggestions: SuggestionInput[], regenerate: boolean) {
  const existing = getSummaryByDate(input.date);
  if (existing && !regenerate) {
    return existing;
  }
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  const conn = database();
  conn.exec("BEGIN");
  try {
    conn
      .prepare(
        `INSERT INTO daily_summaries (
          id, date, coreViews, insights, investmentThemes, evidence, risks, questions, nextSteps,
          disclaimer, sourceMessageCount, sourceNoteCount, sourceVideoViewCount, model, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          coreViews = excluded.coreViews,
          insights = excluded.insights,
          investmentThemes = excluded.investmentThemes,
          evidence = excluded.evidence,
          risks = excluded.risks,
          questions = excluded.questions,
          nextSteps = excluded.nextSteps,
          disclaimer = excluded.disclaimer,
          sourceMessageCount = excluded.sourceMessageCount,
          sourceNoteCount = excluded.sourceNoteCount,
          sourceVideoViewCount = excluded.sourceVideoViewCount,
          model = excluded.model,
          updatedAt = excluded.updatedAt`
      )
      .run(
        id,
        input.date,
        JSON.stringify(input.coreViews),
        JSON.stringify(input.insights),
        JSON.stringify(input.investmentThemes),
        JSON.stringify(input.evidence),
        JSON.stringify(input.risks),
        JSON.stringify(input.questions),
        JSON.stringify(input.nextSteps),
        input.disclaimer,
        input.sourceMessageCount,
        input.sourceNoteCount,
        input.sourceVideoViewCount ?? 0,
        input.model,
        existing?.createdAt || now,
        now
      );

    conn.prepare("DELETE FROM research_suggestions WHERE summaryId = ?").run(id);
    const insertSuggestion = conn.prepare(`
      INSERT INTO research_suggestions
        (id, summaryId, date, title, thesis, rationale, risks, validationSteps, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const suggestion of suggestions.slice(0, 8)) {
      insertSuggestion.run(
        crypto.randomUUID(),
        id,
        input.date,
        suggestion.title.slice(0, 160),
        suggestion.thesis.slice(0, 2000),
        suggestion.rationale.slice(0, 3000),
        JSON.stringify(suggestion.risks),
        JSON.stringify(suggestion.validationSteps),
        now
      );
    }
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return getSummaryByDate(input.date)!;
}

export function listResearchSuggestions(limit = 50): ResearchSuggestion[] {
  const rows = database()
    .prepare("SELECT * FROM research_suggestions ORDER BY date DESC, datetime(createdAt) DESC LIMIT ?")
    .all(limit) as ResearchSuggestionRow[];
  return rows.map(toResearchSuggestion);
}

export function syncBilibiliCreators(mids: string[]) {
  const now = new Date().toISOString();
  const uniqueMids = Array.from(new Set(mids.map((mid) => mid.trim()).filter(Boolean)));
  const stmt = database().prepare(`
    INSERT INTO bilibili_creators (mid, name, enabled, createdAt, updatedAt)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(mid) DO UPDATE SET enabled = 1, updatedAt = excluded.updatedAt
  `);
  for (const mid of uniqueMids) {
    stmt.run(mid, `UP ${mid}`, now, now);
  }
  return listBilibiliCreators();
}

export function updateBilibiliCreator(mid: string, input: { name?: string; lastCollectedAt?: string }) {
  const current = database().prepare("SELECT * FROM bilibili_creators WHERE mid = ?").get(mid) as BilibiliCreatorRow | undefined;
  if (!current) {
    return null;
  }
  database()
    .prepare("UPDATE bilibili_creators SET name = ?, lastCollectedAt = ?, updatedAt = ? WHERE mid = ?")
    .run(input.name || current.name, input.lastCollectedAt || current.lastCollectedAt || null, new Date().toISOString(), mid);
  const row = database().prepare("SELECT * FROM bilibili_creators WHERE mid = ?").get(mid) as BilibiliCreatorRow;
  return toBilibiliCreator(row);
}

export function listBilibiliCreators(): BilibiliCreator[] {
  const rows = database()
    .prepare("SELECT * FROM bilibili_creators WHERE enabled = 1 ORDER BY datetime(updatedAt) DESC")
    .all() as BilibiliCreatorRow[];
  return rows.map(toBilibiliCreator);
}

export function upsertBilibiliVideo(input: VideoInput): BilibiliVideo {
  const existing = database().prepare("SELECT * FROM bilibili_videos WHERE bvid = ?").get(input.bvid) as BilibiliVideoRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  database()
    .prepare(
      `INSERT INTO bilibili_videos (
        id, bvid, aid, cid, creatorMid, creatorName, title, description, tags, videoUrl, publishedAt,
        collectedAt, transcript, transcriptSource, status, summaryStatus, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bvid) DO UPDATE SET
        aid = excluded.aid,
        cid = excluded.cid,
        creatorMid = excluded.creatorMid,
        creatorName = excluded.creatorName,
        title = excluded.title,
        description = excluded.description,
        tags = excluded.tags,
        videoUrl = excluded.videoUrl,
        publishedAt = excluded.publishedAt,
        collectedAt = excluded.collectedAt,
        transcript = excluded.transcript,
        transcriptSource = excluded.transcriptSource,
        status = excluded.status,
        error = excluded.error,
        updatedAt = excluded.updatedAt`
    )
    .run(
      id,
      input.bvid,
      input.aid || null,
      input.cid || null,
      input.creatorMid,
      input.creatorName,
      input.title.slice(0, 300),
      input.description.slice(0, 10000),
      JSON.stringify(input.tags.slice(0, 30)),
      input.videoUrl,
      input.publishedAt,
      now,
      input.transcript.slice(0, 120000),
      input.transcriptSource,
      input.status,
      existing?.summaryStatus || "pending",
      input.error || null,
      existing?.createdAt || now,
      now
    );
  const row = database().prepare("SELECT * FROM bilibili_videos WHERE bvid = ?").get(input.bvid) as BilibiliVideoRow;
  return toBilibiliVideo(row);
}

export function listBilibiliVideos(limit = 100): BilibiliVideo[] {
  const rows = database()
    .prepare("SELECT * FROM bilibili_videos ORDER BY datetime(publishedAt) DESC LIMIT ?")
    .all(limit) as BilibiliVideoRow[];
  return rows.map(toBilibiliVideo);
}

export function listVideosForAnalysis(limit = 20): BilibiliVideo[] {
  const rows = database()
    .prepare(
      `SELECT v.*
       FROM bilibili_videos v
       LEFT JOIN video_stock_views sv ON sv.videoId = v.id
       WHERE v.status IN ('ready', 'metadata_only')
         AND (v.summaryStatus != 'success' OR sv.id IS NULL)
       GROUP BY v.id
       ORDER BY datetime(v.publishedAt) DESC
       LIMIT ?`
    )
    .all(limit) as BilibiliVideoRow[];
  return rows.map(toBilibiliVideo);
}

export function markVideoSummaryStatus(bvid: string, status: BilibiliVideo["summaryStatus"], error?: string) {
  database()
    .prepare("UPDATE bilibili_videos SET summaryStatus = ?, error = ?, updatedAt = ? WHERE bvid = ?")
    .run(status, error || null, new Date().toISOString(), bvid);
}

export function saveVideoStockViews(video: BilibiliVideo, views: VideoStockViewInput[]) {
  const conn = database();
  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    conn.prepare("DELETE FROM video_stock_views WHERE videoId = ?").run(video.id);
    const stmt = conn.prepare(`
      INSERT INTO video_stock_views (
        id, videoId, bvid, creatorMid, creatorName, title, videoUrl, publishedAt, symbols, companies,
        stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const view of views.slice(0, 12)) {
      stmt.run(
        crypto.randomUUID(),
        video.id,
        video.bvid,
        video.creatorMid,
        video.creatorName,
        video.title,
        video.videoUrl,
        video.publishedAt,
        JSON.stringify(view.symbols.slice(0, 8)),
        JSON.stringify(view.companies.slice(0, 8)),
        view.stance,
        view.coreView.slice(0, 2000),
        JSON.stringify(view.evidence.slice(0, 8)),
        JSON.stringify(view.risks.slice(0, 8)),
        view.confidence,
        view.sourceSnippet.slice(0, 1000),
        view.model,
        now
      );
    }
    conn.prepare("UPDATE bilibili_videos SET summaryStatus = 'success', error = NULL, updatedAt = ? WHERE id = ?").run(now, video.id);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function listVideoStockViews(limit = 100): VideoStockView[] {
  const rows = database()
    .prepare("SELECT * FROM video_stock_views ORDER BY datetime(publishedAt) DESC, datetime(createdAt) DESC LIMIT ?")
    .all(limit) as VideoStockViewRow[];
  return rows.map(toVideoStockView);
}

export function createAiRun(date: string, provider: string, model: string) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  database()
    .prepare("INSERT INTO ai_runs (id, date, provider, model, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, date, provider, model, "running", now, now);
  return id;
}

export function finishAiRun(id: string, status: "success" | "error", error?: string, usage?: { prompt?: number; completion?: number }) {
  database()
    .prepare(
      "UPDATE ai_runs SET status = ?, error = ?, promptTokens = ?, completionTokens = ?, updatedAt = ? WHERE id = ?"
    )
    .run(status, error || null, usage?.prompt ?? null, usage?.completion ?? null, new Date().toISOString(), id);
}

export function listPlatformAccounts(): PlatformAccount[] {
  const rows = database().prepare("SELECT * FROM platform_accounts ORDER BY platform ASC").all() as PlatformAccountRow[];
  return rows.map(toPlatformAccount);
}

export function getPlatformAccountWithCredential(platform: Platform) {
  const row = database().prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(platform) as
    | PlatformAccountRow
    | undefined;
  return row ? { account: toPlatformAccount(row), encryptedCredential: row.credentialsCiphertext } : null;
}

export function upsertPlatformAccount(input: {
  platform: Platform;
  externalUserId: string;
  displayName: string;
  avatarUrl?: string;
  encryptedCredential: string;
}): PlatformAccount {
  const conn = database();
  const existing = conn.prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(input.platform) as
    | PlatformAccountRow
    | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  conn
    .prepare(
      `INSERT INTO platform_accounts (
        id, platform, externalUserId, displayName, avatarUrl, status, credentialsCiphertext,
        lastCheckedAt, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        externalUserId = excluded.externalUserId,
        displayName = excluded.displayName,
        avatarUrl = excluded.avatarUrl,
        status = 'connected',
        credentialsCiphertext = excluded.credentialsCiphertext,
        lastCheckedAt = excluded.lastCheckedAt,
        error = NULL,
        updatedAt = excluded.updatedAt`
    )
    .run(
      id,
      input.platform,
      input.externalUserId,
      input.displayName.slice(0, 120),
      input.avatarUrl || null,
      input.encryptedCredential,
      now,
      existing?.createdAt || now,
      now
    );
  return toPlatformAccount(conn.prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(input.platform) as PlatformAccountRow);
}

export function updatePlatformAccountStatus(
  id: string,
  status: PlatformAccountStatus,
  input: { error?: string; displayName?: string; avatarUrl?: string } = {}
) {
  const conn = database();
  const current = conn.prepare("SELECT * FROM platform_accounts WHERE id = ?").get(id) as PlatformAccountRow | undefined;
  if (!current) {
    return null;
  }
  const now = new Date().toISOString();
  conn
    .prepare(
      `UPDATE platform_accounts
       SET status = ?, displayName = ?, avatarUrl = ?, lastCheckedAt = ?, error = ?, updatedAt = ?
       WHERE id = ?`
    )
    .run(
      status,
      input.displayName || current.displayName,
      input.avatarUrl || current.avatarUrl,
      now,
      input.error || null,
      now,
      id
    );
  return toPlatformAccount(conn.prepare("SELECT * FROM platform_accounts WHERE id = ?").get(id) as PlatformAccountRow);
}

export function deletePlatformAccount(id: string) {
  return Number(database().prepare("DELETE FROM platform_accounts WHERE id = ?").run(id).changes) > 0;
}

export function listCreators(options: { enabledOnly?: boolean; ids?: string[] } = {}): Creator[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (options.enabledOnly) {
    clauses.push("enabled = 1");
  }
  if (options.ids?.length) {
    clauses.push(`id IN (${options.ids.map(() => "?").join(",")})`);
    values.push(...options.ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database()
    .prepare(`SELECT * FROM creators ${where} ORDER BY enabled DESC, name COLLATE NOCASE ASC`)
    .all(...values) as CreatorRow[];
  return rows.map(toCreator);
}

export function listContentCreatorOptions(): ContentCreatorOption[] {
  return database().prepare(`
    SELECT c.id, c.name, c.platform
    FROM creators c
    WHERE EXISTS (SELECT 1 FROM content_items i WHERE i.creatorId = c.id)
    ORDER BY lower(c.name) ASC, c.id ASC
  `).all() as unknown as ContentCreatorOption[];
}

export function getCreator(id: string): Creator | null {
  const row = database().prepare("SELECT * FROM creators WHERE id = ?").get(id) as CreatorRow | undefined;
  return row ? toCreator(row) : null;
}

export function upsertCreator(candidate: CreatorCandidate): Creator {
  const conn = database();
  const existing = conn
    .prepare("SELECT * FROM creators WHERE platform = ? AND externalId = ?")
    .get(candidate.platform, candidate.externalId) as CreatorRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  conn
    .prepare(
      `INSERT INTO creators (
        id, platform, externalId, name, handle, avatarUrl, profileUrl, enabled, lastCollectedAt,
        lastCollectionStatus, lastError, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(platform, externalId) DO UPDATE SET
        name = excluded.name,
        handle = excluded.handle,
        avatarUrl = excluded.avatarUrl,
        profileUrl = excluded.profileUrl,
        enabled = 1,
        updatedAt = excluded.updatedAt`
    )
    .run(
      id,
      candidate.platform,
      candidate.externalId,
      candidate.name.slice(0, 120),
      candidate.handle || null,
      candidate.avatarUrl || null,
      candidate.profileUrl,
      existing?.createdAt || now,
      now
    );
  const row = conn
    .prepare("SELECT * FROM creators WHERE platform = ? AND externalId = ?")
    .get(candidate.platform, candidate.externalId) as CreatorRow;
  return toCreator(row);
}

export function setCreatorEnabled(id: string, enabled: boolean) {
  const result = database()
    .prepare("UPDATE creators SET enabled = ?, updatedAt = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return Number(result.changes) > 0 ? getCreator(id) : null;
}

export function updateCreatorCollection(
  id: string,
  status: "success" | "error",
  input: { error?: string; name?: string; avatarUrl?: string } = {}
) {
  const conn = database();
  const current = conn.prepare("SELECT * FROM creators WHERE id = ?").get(id) as CreatorRow | undefined;
  if (!current) {
    return null;
  }
  const now = new Date().toISOString();
  conn
    .prepare(
      `UPDATE creators
       SET name = ?, avatarUrl = ?, lastCollectedAt = ?, lastCollectionStatus = ?, lastError = ?, updatedAt = ?
       WHERE id = ?`
    )
    .run(input.name || current.name, input.avatarUrl || current.avatarUrl, now, status, input.error || null, now, id);
  return getCreator(id);
}

export function upsertContent(input: ContentInput): { content: ContentItem; isNew: boolean } {
  const conn = database();
  const existing = conn
    .prepare("SELECT * FROM content_items WHERE platform = ? AND externalId = ?")
    .get(input.platform, input.externalId) as ContentItemRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  const upgradedTranscript = existing?.transcriptSource === "metadata" && input.transcriptSource === "subtitle";
  const analysisStatus = upgradedTranscript || existing?.analysisStatus === "error" ? "pending" : existing?.analysisStatus || "pending";
  conn
    .prepare(
      `INSERT INTO content_items (
        id, platform, externalId, creatorId, creatorExternalId, creatorName, contentType, title, description,
        tags, sourceUrl, coverUrl, publishedAt, collectedAt, transcript, transcriptSource, status,
        analysisStatus, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, externalId) DO UPDATE SET
        creatorId = excluded.creatorId,
        creatorExternalId = excluded.creatorExternalId,
        creatorName = excluded.creatorName,
        title = excluded.title,
        description = excluded.description,
        tags = excluded.tags,
        sourceUrl = excluded.sourceUrl,
        coverUrl = excluded.coverUrl,
        publishedAt = excluded.publishedAt,
        transcript = excluded.transcript,
        transcriptSource = excluded.transcriptSource,
        status = excluded.status,
        analysisStatus = excluded.analysisStatus,
        error = excluded.error,
        updatedAt = excluded.updatedAt`
    )
    .run(
      id,
      input.platform,
      input.externalId,
      input.creatorId,
      input.creatorExternalId,
      input.creatorName,
      input.contentType,
      input.title.slice(0, 300),
      input.description.slice(0, 10000),
      JSON.stringify(input.tags.slice(0, 30)),
      input.sourceUrl,
      input.coverUrl || null,
      input.publishedAt,
      existing?.collectedAt || now,
      input.transcript.slice(0, 120000),
      input.transcriptSource,
      input.status,
      analysisStatus,
      input.error || null,
      existing?.createdAt || now,
      now
    );
  const row = conn
    .prepare("SELECT * FROM content_items WHERE platform = ? AND externalId = ?")
    .get(input.platform, input.externalId) as ContentItemRow;
  return { content: toContentItem(row), isNew: !existing };
}

export function getContentItem(id: string): ContentItem | null {
  const row = database().prepare("SELECT * FROM content_items WHERE id = ?").get(id) as ContentItemRow | undefined;
  return row ? toContentItem(row) : null;
}

export function markContentAnalysisStatus(id: string, status: ContentItem["analysisStatus"], error?: string) {
  database()
    .prepare("UPDATE content_items SET analysisStatus = ?, error = ?, updatedAt = ? WHERE id = ?")
    .run(status, error || null, new Date().toISOString(), id);
}

export function saveContentStockViews(content: ContentItem, views: ContentStockViewInput[]) {
  const conn = database();
  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    conn.prepare("DELETE FROM content_stock_views WHERE contentId = ?").run(content.id);
    const insert = conn.prepare(`
      INSERT INTO content_stock_views (
        id, contentId, platform, creatorId, creatorExternalId, creatorName, title, sourceUrl, publishedAt,
        collectedAt, symbols, companies, stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const view of views.slice(0, 12)) {
      insert.run(
        crypto.randomUUID(),
        content.id,
        content.platform,
        content.creatorId,
        content.creatorExternalId,
        content.creatorName,
        content.title,
        content.sourceUrl,
        content.publishedAt,
        content.collectedAt,
        JSON.stringify(view.symbols.slice(0, 8)),
        JSON.stringify(view.companies.slice(0, 8)),
        view.stance,
        view.coreView.slice(0, 2000),
        JSON.stringify(view.evidence.slice(0, 8)),
        JSON.stringify(view.risks.slice(0, 8)),
        view.confidence,
        view.sourceSnippet.slice(0, 1000),
        view.model,
        now
      );
    }
    conn.prepare("UPDATE content_items SET analysisStatus = 'success', error = NULL, updatedAt = ? WHERE id = ?").run(now, content.id);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function listContentInsights(options: {
  publishedDate?: string;
  collectedDate?: string;
  creatorId?: string;
  query?: string;
  page?: number;
  pageSize?: ContentInsightsPageSize;
} = {}): ContentInsightsResponse {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const filteredDate = options.publishedDate || options.collectedDate;
  if (filteredDate) {
    const start = new Date(`${filteredDate}T00:00:00.000+08:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    clauses.push(`c.${options.publishedDate ? "publishedAt" : "collectedAt"} >= ? AND c.${options.publishedDate ? "publishedAt" : "collectedAt"} < ?`);
    values.push(start.toISOString(), end.toISOString());
  }
  if (options.creatorId) {
    clauses.push("c.creatorId = ?");
    values.push(options.creatorId);
  }
  if (options.query) {
    const query = `%${options.query.toLowerCase()}%`;
    clauses.push(`(
      lower(c.creatorName) LIKE ? OR lower(c.title) LIKE ? OR lower(c.description) LIKE ? OR
      EXISTS (
        SELECT 1 FROM content_stock_views v
        WHERE v.contentId = c.id AND (
          lower(v.coreView) LIKE ? OR lower(v.symbols) LIKE ? OR lower(v.companies) LIKE ?
        )
      )
    )`);
    values.push(query, query, query, query, query, query);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageSize = options.pageSize || 10;
  const requestedPage = options.page || 1;
  const conn = database();
  const aggregate = conn.prepare(`
    WITH filtered_content AS (
      SELECT c.id FROM content_items c ${where}
    ), targets AS (
      SELECT trim(CAST(symbol.value AS TEXT)) AS target
      FROM content_stock_views v
      JOIN filtered_content f ON f.id = v.contentId,
      json_each(v.symbols) symbol
      UNION
      SELECT trim(CAST(company.value AS TEXT)) AS target
      FROM content_stock_views v
      JOIN filtered_content f ON f.id = v.contentId,
      json_each(v.companies) company
    )
    SELECT
      (SELECT COUNT(*) FROM filtered_content) AS contentCount,
      (SELECT COUNT(*) FROM content_stock_views v JOIN filtered_content f ON f.id = v.contentId) AS viewCount,
      (SELECT COUNT(*) FROM targets WHERE target <> '') AS targetCount
  `).get(...values) as { contentCount: number; viewCount: number; targetCount: number };
  const totalPages = aggregate.contentCount ? Math.ceil(aggregate.contentCount / pageSize) : 0;
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const contentRows = conn
    .prepare(`SELECT c.* FROM content_items c ${where} ORDER BY c.publishedAt DESC, c.collectedAt DESC, c.id DESC LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize) as ContentItemRow[];
  const pagination = { page, pageSize, totalItems: aggregate.contentCount, totalPages };
  const summary = {
    contentCount: aggregate.contentCount,
    viewCount: aggregate.viewCount,
    targetCount: aggregate.targetCount
  };
  if (!contentRows.length) return { insights: [], pagination, summary };
  const ids = contentRows.map((row) => row.id);
  const viewRows = conn
    .prepare(`SELECT * FROM content_stock_views WHERE contentId IN (${ids.map(() => "?").join(",")}) ORDER BY createdAt ASC`)
    .all(...ids) as ContentStockViewRow[];
  const viewsByContent = new Map<string, ContentStockView[]>();
  for (const row of viewRows) {
    const views = viewsByContent.get(row.contentId) || [];
    views.push(toContentStockView(row));
    viewsByContent.set(row.contentId, views);
  }
  return {
    insights: contentRows.map((row) => ({ content: toContentItem(row), views: viewsByContent.get(row.id) || [] })),
    pagination,
    summary
  };
}

function runItems(runId: string) {
  const rows = database()
    .prepare("SELECT * FROM collection_run_items WHERE runId = ? ORDER BY rowid ASC")
    .all(runId) as CollectionRunItemRow[];
  return rows.map(toCollectionRunItem);
}

export function getCollectionRun(id: string): CollectionRun | null {
  const row = database().prepare("SELECT * FROM collection_runs WHERE id = ?").get(id) as CollectionRunRow | undefined;
  return row ? toCollectionRun(row, runItems(row.id)) : null;
}

export function listCollectionRuns(limit = 30): CollectionRun[] {
  const rows = database()
    .prepare("SELECT * FROM collection_runs ORDER BY datetime(createdAt) DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 100)) as CollectionRunRow[];
  return rows.map((row) => toCollectionRun(row, runItems(row.id)));
}

export function createCollectionRun(
  trigger: CollectionRunTrigger,
  creators: Creator[],
  scheduledFor?: string
): { run: CollectionRun; created: boolean } {
  const conn = database();
  if (trigger === "scheduled" && scheduledFor) {
    const existing = conn
      .prepare("SELECT id FROM collection_runs WHERE trigger = 'scheduled' AND scheduledFor = ?")
      .get(scheduledFor) as { id: string } | undefined;
    if (existing) {
      return { run: getCollectionRun(existing.id)!, created: false };
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    conn
      .prepare(
        `INSERT INTO collection_runs (
          id, trigger, status, scheduledFor, creatorCount, discoveredCount, newContentCount,
          analyzedCount, errorCount, error, startedAt, completedAt, createdAt
        ) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?)`
      )
      .run(id, trigger, scheduledFor || null, creators.length, now);
    const insertItem = conn.prepare(`
      INSERT INTO collection_run_items (
        id, runId, creatorId, creatorName, status, discoveredCount, newContentCount, analyzedCount,
        errorCode, error, startedAt, completedAt
      ) VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, NULL, NULL, NULL, NULL)
    `);
    for (const creator of creators) {
      insertItem.run(crypto.randomUUID(), id, creator.id, creator.name);
    }
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return { run: getCollectionRun(id)!, created: true };
}

export function getNextQueuedCollectionRun() {
  const row = database()
    .prepare("SELECT * FROM collection_runs WHERE status = 'queued' ORDER BY datetime(createdAt) ASC LIMIT 1")
    .get() as CollectionRunRow | undefined;
  return row ? toCollectionRun(row, runItems(row.id)) : null;
}

export function claimNextQueuedCollectionRun(
  leaseOwner = "single-worker",
  leaseExpiresAt = Date.now() + 2 * 60 * 1000
) {
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const queued = conn
      .prepare(`
        SELECT id, status FROM collection_runs
        WHERE status = 'queued' OR (status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?))
        ORDER BY datetime(createdAt) ASC, rowid ASC LIMIT 1
      `)
      .get(Date.now()) as { id: string; status: CollectionRunStatus } | undefined;
    if (!queued) {
      conn.exec("COMMIT");
      return null;
    }
    if (queued.status === "running") {
      conn.prepare(`
        UPDATE collection_run_items
        SET status = 'queued', startedAt = NULL, completedAt = NULL, errorCode = NULL, error = NULL
        WHERE runId = ? AND status = 'running'
      `).run(queued.id);
    }
    const result = conn
      .prepare(`
        UPDATE collection_runs
        SET status = 'running', startedAt = COALESCE(startedAt, ?), error = NULL,
            leaseOwner = ?, leaseExpiresAt = ?
        WHERE id = ? AND (status = 'queued' OR (status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)))
      `)
      .run(new Date().toISOString(), leaseOwner, leaseExpiresAt, queued.id, Date.now());
    conn.exec("COMMIT");
    return Number(result.changes) === 1 ? getCollectionRun(queued.id) : null;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function renewCollectionRunLease(id: string, leaseOwner: string, leaseExpiresAt: number) {
  const result = database()
    .prepare("UPDATE collection_runs SET leaseExpiresAt = ? WHERE id = ? AND status = 'running' AND leaseOwner = ?")
    .run(leaseExpiresAt, id, leaseOwner);
  return Number(result.changes) === 1;
}

export function startCollectionRun(id: string) {
  const now = new Date().toISOString();
  database().prepare("UPDATE collection_runs SET status = 'running', startedAt = ?, error = NULL WHERE id = ? AND status = 'queued'").run(now, id);
  return getCollectionRun(id);
}

export function startCollectionRunItem(id: string) {
  database()
    .prepare("UPDATE collection_run_items SET status = 'running', startedAt = ?, errorCode = NULL, error = NULL WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function finishCollectionRunItem(
  id: string,
  input: {
    status: "success" | "error";
    discoveredCount?: number;
    newContentCount?: number;
    analyzedCount?: number;
    errorCode?: string;
    error?: string;
  }
) {
  database()
    .prepare(
      `UPDATE collection_run_items
       SET status = ?, discoveredCount = ?, newContentCount = ?, analyzedCount = ?,
           errorCode = ?, error = ?, completedAt = ?
       WHERE id = ?`
    )
    .run(
      input.status,
      input.discoveredCount || 0,
      input.newContentCount || 0,
      input.analyzedCount || 0,
      input.errorCode || null,
      input.error || null,
      new Date().toISOString(),
      id
    );
}

export function finishCollectionRun(id: string, fatalError?: string) {
  const conn = database();
  const totals = conn
    .prepare(
      `SELECT
        COALESCE(SUM(discoveredCount), 0) AS discoveredCount,
        COALESCE(SUM(newContentCount), 0) AS newContentCount,
        COALESCE(SUM(analyzedCount), 0) AS analyzedCount,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorCount,
        COUNT(*) AS creatorCount
       FROM collection_run_items WHERE runId = ?`
    )
    .get(id) as {
    discoveredCount: number;
    newContentCount: number;
    analyzedCount: number;
    errorCount: number;
    creatorCount: number;
  };
  let status: CollectionRunStatus = "success";
  if (fatalError || (totals.creatorCount > 0 && totals.errorCount === totals.creatorCount)) {
    status = "error";
  } else if (totals.errorCount > 0) {
    status = "partial";
  }
  conn
    .prepare(
      `UPDATE collection_runs
       SET status = ?, creatorCount = ?, discoveredCount = ?, newContentCount = ?, analyzedCount = ?,
           errorCount = ?, error = ?, completedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL
       WHERE id = ?`
    )
    .run(
      status,
      totals.creatorCount,
      totals.discoveredCount,
      totals.newContentCount,
      totals.analyzedCount,
      totals.errorCount,
      fatalError || null,
      new Date().toISOString(),
      id
    );
  return getCollectionRun(id)!;
}

export function recoverInterruptedCollectionRuns(now = Date.now()) {
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const expired = conn.prepare(`
      SELECT id FROM collection_runs
      WHERE status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
    `).all(now) as Array<{ id: string }>;
    const ids = expired.map((row) => row.id);
    if (!ids.length) {
      conn.exec("COMMIT");
      return 0;
    }
    const placeholders = ids.map(() => "?").join(",");
    conn.prepare(`
      UPDATE collection_runs
      SET status = 'queued', startedAt = NULL, leaseOwner = NULL, leaseExpiresAt = NULL
      WHERE id IN (${placeholders})
    `).run(...ids);
    conn
      .prepare(
        `UPDATE collection_run_items
         SET status = 'queued', startedAt = NULL, completedAt = NULL, errorCode = NULL, error = NULL
         WHERE status = 'running' AND runId IN (${placeholders})`
      )
      .run(...ids);
    conn.exec("COMMIT");
    return ids.length;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function getCollectionSettings(): CollectionSettings {
  const row = database().prepare("SELECT * FROM collection_settings WHERE id = 'owner'").get() as {
    enabled: number;
    localTime: string;
    timezone: "Asia/Shanghai";
    maxVideosPerCreator: number;
    updatedAt: string;
  };
  return {
    enabled: Boolean(row.enabled),
    localTime: row.localTime,
    timezone: row.timezone,
    maxVideosPerCreator: row.maxVideosPerCreator,
    updatedAt: row.updatedAt
  };
}

export function updateCollectionSettings(input: { enabled: boolean; localTime: string; maxVideosPerCreator: number }) {
  const now = new Date().toISOString();
  database()
    .prepare(
      `UPDATE collection_settings
       SET enabled = ?, localTime = ?, maxVideosPerCreator = ?, updatedAt = ?
       WHERE id = 'owner'`
    )
    .run(input.enabled ? 1 : 0, input.localTime, input.maxVideosPerCreator, now);
  return getCollectionSettings();
}

const portfolioCurrencies: PortfolioCurrency[] = ["CNY", "HKD", "USD"];
const portfolioSectorColors = ["#bf2f25", "#83b92f", "#32312f", "#42a7d6", "#cf672c", "#5369dc", "#9a58b5", "#178a78"];

function portfolioNumber(value: unknown, label: string, options: { positive?: boolean } = {}) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (options.positive && number <= 0)) {
    throw new Error(`${label}必须是${options.positive ? "大于 0" : "不小于 0"}的数字。`);
  }
  return number;
}

function portfolioText(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, maxLength);
}

function portfolioImageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") throw new Error("图片地址必须使用 HTTPS。");
    return url.toString().slice(0, 1000);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "图片地址无效。");
  }
}

function portfolioCurrency(value: unknown): PortfolioCurrency {
  if (value === "CNY" || value === "HKD" || value === "USD") return value;
  throw new Error("币种只支持 CNY、HKD 或 USD。");
}

function normalizePortfolioDraft(input: PortfolioDraft): PortfolioDraft {
  if (!input || typeof input !== "object") throw new Error("持仓草稿格式不正确。");
  if (!Array.isArray(input.positions) || input.positions.length > 200) throw new Error("持仓数量不能超过 200 条。");
  const seenKeys = new Set<string>();
  const seenSymbols = new Set<string>();
  const positions = input.positions.map((position, index) => {
    const positionKey = /^[a-zA-Z0-9_-]{8,80}$/.test(position.positionKey || "")
      ? position.positionKey
      : crypto.randomUUID();
    const symbol = portfolioText(position.symbol, "", 24).toUpperCase();
    const market = portfolioText(position.market, "", 40);
    if (!symbol || !market) throw new Error(`第 ${index + 1} 条持仓缺少代码或市场。`);
    const uniquenessKey = `${market.toLowerCase()}::${symbol.toLowerCase()}`;
    if (seenKeys.has(positionKey) || seenSymbols.has(uniquenessKey)) throw new Error("同一市场不能存在重复持仓代码。");
    seenKeys.add(positionKey);
    seenSymbols.add(uniquenessKey);
    if (position.assetType !== "stock" && position.assetType !== "etf") throw new Error("资产类型只支持股票或 ETF。");
    return {
      positionKey,
      symbol,
      name: portfolioText(position.name, symbol, 80),
      assetType: position.assetType,
      market,
      sector: portfolioText(position.sector, "其他", 40),
      currency: portfolioCurrency(position.currency),
      quantity: portfolioNumber(position.quantity, `${symbol} 股数`),
      averageCost: portfolioNumber(position.averageCost, `${symbol} 平均成本`),
      lastPrice: portfolioNumber(position.lastPrice, `${symbol} 最新价`),
      logoUrl: portfolioImageUrl(position.logoUrl),
      sortOrder: index
    } satisfies PortfolioDraftPosition;
  });

  const cashByCurrency = new Map<PortfolioCurrency, number>();
  for (const cash of Array.isArray(input.cashBalances) ? input.cashBalances : []) {
    const currency = portfolioCurrency(cash.currency);
    if (cashByCurrency.has(currency)) throw new Error(`现金币种 ${currency} 重复。`);
    cashByCurrency.set(currency, portfolioNumber(cash.balance, `${currency} 现金`));
  }
  const fxByCurrency = new Map<PortfolioCurrency, number>();
  for (const fx of Array.isArray(input.fxRates) ? input.fxRates : []) {
    const currency = portfolioCurrency(fx.currency);
    if (fxByCurrency.has(currency)) throw new Error(`汇率币种 ${currency} 重复。`);
    fxByCurrency.set(currency, currency === "CNY" ? 1 : portfolioNumber(fx.rateToCny, `${currency} 汇率`, { positive: true }));
  }
  for (const position of positions) {
    if (position.currency !== "CNY" && !fxByCurrency.has(position.currency)) {
      throw new Error(`请填写 ${position.currency} 兑人民币汇率。`);
    }
  }
  return {
    id: input.id || "",
    title: portfolioText(input.title, "我的持仓全景图", 80),
    subtitle: portfolioText(input.subtitle, "按板块分类的个人资产配置", 160),
    ownerName: portfolioText(input.ownerName, "Stockpulse", 80),
    avatarUrl: portfolioImageUrl(input.avatarUrl),
    positions,
    cashBalances: portfolioCurrencies.map((currency) => ({ currency, balance: cashByCurrency.get(currency) || 0 })),
    fxRates: portfolioCurrencies.map((currency) => ({ currency, rateToCny: currency === "CNY" ? 1 : fxByCurrency.get(currency) || 1 })),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function readPortfolioSnapshot(conn: DatabaseSync, row: PortfolioSnapshotRow): PortfolioDraft {
  const positions = conn
    .prepare("SELECT * FROM portfolio_positions WHERE snapshotId = ? ORDER BY sortOrder ASC, rowid ASC")
    .all(row.id) as PortfolioPositionRow[];
  const cash = conn
    .prepare("SELECT * FROM portfolio_cash_balances WHERE snapshotId = ? ORDER BY currency ASC")
    .all(row.id) as unknown as PortfolioCashRow[];
  const fxRates = conn
    .prepare("SELECT * FROM portfolio_fx_rates WHERE snapshotId = ? ORDER BY currency ASC")
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

function latestPortfolioRows(conn: DatabaseSync) {
  return conn
    .prepare("SELECT * FROM portfolio_snapshots WHERE status = 'published' ORDER BY datetime(publishedAt) DESC, rowid DESC LIMIT 2")
    .all() as PortfolioSnapshotRow[];
}

export function getPortfolioDraft(): PortfolioDraftResponse {
  const conn = database();
  const row = conn.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const latest = latestPortfolioRows(conn)[0];
  return {
    draft: readPortfolioSnapshot(conn, row),
    dirty: !latest || row.updatedAt > (latest.publishedAt || latest.updatedAt),
    latestPublishedAt: latest?.publishedAt || undefined
  };
}

export function savePortfolioDraft(input: PortfolioDraft): PortfolioDraftResponse {
  const conn = database();
  const current = conn.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const draft = normalizePortfolioDraft(input);
  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    conn.prepare(`
      UPDATE portfolio_snapshots
      SET title = ?, subtitle = ?, ownerName = ?, avatarUrl = ?, updatedAt = ?
      WHERE id = ? AND status = 'draft'
    `).run(draft.title, draft.subtitle, draft.ownerName, draft.avatarUrl || null, now, current.id);
    conn.prepare("DELETE FROM portfolio_positions WHERE snapshotId = ?").run(current.id);
    conn.prepare("DELETE FROM portfolio_cash_balances WHERE snapshotId = ?").run(current.id);
    conn.prepare("DELETE FROM portfolio_fx_rates WHERE snapshotId = ?").run(current.id);
    const insertPosition = conn.prepare(`
      INSERT INTO portfolio_positions (
        id, snapshotId, positionKey, symbol, name, assetType, market, sector, currency,
        quantity, averageCost, lastPrice, logoUrl, sortOrder
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const position of draft.positions) {
      insertPosition.run(
        crypto.randomUUID(), current.id, position.positionKey, position.symbol, position.name, position.assetType,
        position.market, position.sector, position.currency, position.quantity, position.averageCost,
        position.lastPrice, position.logoUrl || null, position.sortOrder
      );
    }
    const insertCash = conn.prepare("INSERT INTO portfolio_cash_balances (id, snapshotId, currency, balance) VALUES (?, ?, ?, ?)");
    for (const cash of draft.cashBalances) insertCash.run(crypto.randomUUID(), current.id, cash.currency, cash.balance);
    const insertFx = conn.prepare("INSERT INTO portfolio_fx_rates (id, snapshotId, currency, rateToCny) VALUES (?, ?, ?, ?)");
    for (const fx of draft.fxRates) insertFx.run(crypto.randomUUID(), current.id, fx.currency, fx.rateToCny);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return getPortfolioDraft();
}

export function publishPortfolioDraft() {
  const conn = database();
  const source = conn.prepare("SELECT * FROM portfolio_snapshots WHERE status = 'draft'").get() as PortfolioSnapshotRow;
  const draft = normalizePortfolioDraft(readPortfolioSnapshot(conn, source));
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();
  conn.exec("BEGIN");
  try {
    conn.prepare(`
      INSERT INTO portfolio_snapshots (
        id, status, title, subtitle, ownerName, avatarUrl, createdAt, updatedAt, publishedAt
      ) VALUES (?, 'published', ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, draft.title, draft.subtitle, draft.ownerName, draft.avatarUrl || null, now, now, now);
    const insertPosition = conn.prepare(`
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
    const insertCash = conn.prepare("INSERT INTO portfolio_cash_balances (id, snapshotId, currency, balance) VALUES (?, ?, ?, ?)");
    for (const cash of draft.cashBalances) insertCash.run(crypto.randomUUID(), snapshotId, cash.currency, cash.balance);
    const insertFx = conn.prepare("INSERT INTO portfolio_fx_rates (id, snapshotId, currency, rateToCny) VALUES (?, ?, ?, ?)");
    for (const fx of draft.fxRates) insertFx.run(crypto.randomUUID(), snapshotId, fx.currency, fx.rateToCny);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return getPortfolio("admin");
}

function sectorColor(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return portfolioSectorColors[Math.abs(hash) % portfolioSectorColors.length]!;
}

export function getPortfolio(accessLevel: PortfolioAccessLevel): PortfolioResponse {
  const conn = database();
  const [currentRow, previousRow] = latestPortfolioRows(conn);
  if (!currentRow?.publishedAt) return { accessLevel, portfolio: null };
  const current = readPortfolioSnapshot(conn, currentRow);
  const previous = previousRow ? readPortfolioSnapshot(conn, previousRow) : null;
  const previousQuantities = new Map(previous?.positions.map((position) => [position.positionKey, position.quantity]) || []);
  const fxRates = new Map(current.fxRates.map((fx) => [fx.currency, fx.rateToCny]));
  const canViewSensitive = accessLevel !== "public";
  const positionMetrics = current.positions.map((position) => {
    const fx = fxRates.get(position.currency) || 1;
    const marketValueCny = position.quantity * position.lastPrice * fx;
    const costValueCny = position.quantity * position.averageCost * fx;
    const unrealizedPnlCny = marketValueCny - costValueCny;
    return { position, marketValueCny, costValueCny, unrealizedPnlCny };
  });
  const stockMarketValueCny = positionMetrics.reduce((sum, item) => sum + item.marketValueCny, 0);
  const stockCostValueCny = positionMetrics.reduce((sum, item) => sum + item.costValueCny, 0);
  const cashMetrics = current.cashBalances.map((cash) => ({
    ...cash,
    marketValueCny: cash.balance * (fxRates.get(cash.currency) || 1)
  }));
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
  const sectors: PortfolioSectorView[] = [...sectorMap.entries()]
    .map(([name, aggregate]) => ({
      name,
      color: sectorColor(name),
      weightPercent: totalAssetsCny > 0 ? aggregate.marketValueCny / totalAssetsCny * 100 : 0,
      positionCount: aggregate.positionCount,
      ...(canViewSensitive ? { marketValueCny: aggregate.marketValueCny } : {})
    }))
    .sort((left, right) => right.weightPercent - left.weightPercent);
  const cash: PortfolioCashView[] = cashMetrics
    .filter((item) => item.balance > 0)
    .map((item) => ({
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
