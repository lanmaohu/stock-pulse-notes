import crypto from "node:crypto";
import fsp from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { PortfolioCurrency } from "../../shared/types.js";
import { database, databaseDirectory } from "./connection.js";
import { databasePath } from "../config.js";
import { schemaProblems } from "./schema.js";
import { createVerifiedBackup, databaseSourceHash, verifyBackup, type BackupVerification } from "../operations/backup.js";

export const latestSchemaMigration = "2026-08-analysis-model-v1";
export const legacyRemovalMigration = "2026-08-remove-legacy-v1";
const baseSchemaMigration = "2026-08-stability-v1";
const operationsSchemaMigration = "2026-08-ops-v1";
const legacyMediaMigration = "2026-07-media-monitor-v1";
const legacyTables = [
  "notes",
  "daily_summaries",
  "research_suggestions",
  "ai_runs",
  "video_stock_views",
  "bilibili_videos",
  "bilibili_creators"
] as const;

let schemaReady = false;

function tableExists(connection: DatabaseSync, name: string) {
  return Boolean(connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function applied(connection: DatabaseSync, name: string) {
  return Boolean(connection.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name));
}

function applyBaseSchema(connection: DatabaseSync) {
  connection.exec(`
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
      analysisModel TEXT NOT NULL DEFAULT 'deepseek-v4-pro'
        CHECK(analysisModel IN ('deepseek-v4-flash', 'deepseek-v4-pro')),
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_runs_scheduled
      ON collection_runs(trigger, scheduledFor)
      WHERE trigger = 'scheduled' AND scheduledFor IS NOT NULL;
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

  const runColumns = connection.prepare("PRAGMA table_info(collection_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "leaseOwner")) connection.exec("ALTER TABLE collection_runs ADD COLUMN leaseOwner TEXT");
  if (!runColumns.some((column) => column.name === "leaseExpiresAt")) connection.exec("ALTER TABLE collection_runs ADD COLUMN leaseExpiresAt INTEGER");

  const now = new Date().toISOString();
  const configuredTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(process.env.BILIBILI_COLLECT_CRON_TIME || "")
    ? process.env.BILIBILI_COLLECT_CRON_TIME!
    : "07:30";
  connection.prepare(`
    INSERT OR IGNORE INTO collection_settings
      (id, enabled, localTime, timezone, maxVideosPerCreator, analysisModel, updatedAt)
    VALUES ('owner', 1, ?, 'Asia/Shanghai', 5, 'deepseek-v4-pro', ?)
  `).run(configuredTime, now);

  if (!connection.prepare("SELECT 1 FROM portfolio_snapshots WHERE status = 'draft'").get()) {
    const snapshotId = crypto.randomUUID();
    connection.prepare(`
      INSERT INTO portfolio_snapshots
        (id, status, title, subtitle, ownerName, avatarUrl, createdAt, updatedAt, publishedAt)
      VALUES (?, 'draft', ?, ?, ?, NULL, ?, ?, NULL)
    `).run(snapshotId, "我的持仓全景图", "按板块分类的个人资产配置", "Stockpulse", now, now);
    const insertCash = connection.prepare("INSERT INTO portfolio_cash_balances (id, snapshotId, currency, balance) VALUES (?, ?, ?, 0)");
    const insertFx = connection.prepare("INSERT INTO portfolio_fx_rates (id, snapshotId, currency, rateToCny) VALUES (?, ?, ?, ?)");
    for (const currency of ["CNY", "HKD", "USD"] as PortfolioCurrency[]) {
      insertCash.run(crypto.randomUUID(), snapshotId, currency);
      insertFx.run(crypto.randomUUID(), snapshotId, currency, 1);
    }
  }
}

function applyOperationsSchema(connection: DatabaseSync) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      serviceName TEXT PRIMARY KEY,
      instanceId TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('starting', 'ready', 'stopping')),
      startedAt TEXT NOT NULL,
      heartbeatAt TEXT NOT NULL
    );
  `);
}

function applyAnalysisModelSchema(connection: DatabaseSync) {
  const columns = connection.prepare("PRAGMA table_info(collection_settings)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "analysisModel")) {
    connection.exec(`
      ALTER TABLE collection_settings ADD COLUMN analysisModel TEXT NOT NULL DEFAULT 'deepseek-v4-pro'
        CHECK(analysisModel IN ('deepseek-v4-flash', 'deepseek-v4-pro'))
    `);
  }
}

type LegacyCreatorRow = { mid: string; name: string; lastCollectedAt: string | null; createdAt: string; updatedAt: string };
type LegacyVideoRow = {
  id: string; bvid: string; creatorMid: string; creatorName: string; title: string; description: string; tags: string;
  videoUrl: string; publishedAt: string; collectedAt: string; transcript: string; transcriptSource: string; status: string;
  summaryStatus: string; error: string | null; createdAt: string; updatedAt: string;
};
type LegacyViewRow = {
  id: string; videoId: string; creatorMid: string; creatorName: string; title: string; videoUrl: string; publishedAt: string;
  symbols: string; companies: string; stance: string; coreView: string; evidence: string; risks: string; confidence: string;
  sourceSnippet: string; model: string; createdAt: string;
};

function migrateLegacyMedia(connection: DatabaseSync) {
  if (!tableExists(connection, "bilibili_videos")) return;
  const creators = tableExists(connection, "bilibili_creators")
    ? connection.prepare("SELECT * FROM bilibili_creators").all() as LegacyCreatorRow[]
    : [];
  const videos = connection.prepare("SELECT * FROM bilibili_videos ORDER BY datetime(publishedAt)").all() as LegacyVideoRow[];
  const creatorIds = new Map<string, string>();
  const ensureCreator = (externalId: string, name: string, lastCollectedAt?: string | null) => {
    const cached = creatorIds.get(externalId);
    if (cached) return cached;
    const existing = connection.prepare("SELECT id FROM creators WHERE platform = 'bilibili' AND externalId = ?").get(externalId) as { id: string } | undefined;
    const id = existing?.id || crypto.randomUUID();
    const now = new Date().toISOString();
    connection.prepare(`
      INSERT OR IGNORE INTO creators
        (id, platform, externalId, name, handle, avatarUrl, profileUrl, enabled, lastCollectedAt,
         lastCollectionStatus, lastError, createdAt, updatedAt)
      VALUES (?, 'bilibili', ?, ?, NULL, NULL, ?, 1, ?, ?, NULL, ?, ?)
    `).run(id, externalId, name || `UP ${externalId}`, `https://space.bilibili.com/${externalId}`,
      lastCollectedAt || null, lastCollectedAt ? "success" : null, now, now);
    creatorIds.set(externalId, id);
    return id;
  };
  for (const creator of creators) ensureCreator(creator.mid, creator.name, creator.lastCollectedAt);
  const insertContent = connection.prepare(`
    INSERT OR IGNORE INTO content_items
      (id, platform, externalId, creatorId, creatorExternalId, creatorName, contentType, title, description,
       tags, sourceUrl, coverUrl, publishedAt, collectedAt, transcript, transcriptSource, status,
       analysisStatus, error, createdAt, updatedAt)
    VALUES (?, 'bilibili', ?, ?, ?, ?, 'video', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const video of videos) {
    const creatorId = ensureCreator(video.creatorMid, video.creatorName, video.collectedAt);
    const status = video.status === "ready" || video.status === "error" ? video.status : "metadata_only";
    const analysis = video.summaryStatus === "success" || video.summaryStatus === "error" ? video.summaryStatus : "pending";
    insertContent.run(video.id, video.bvid, creatorId, video.creatorMid, video.creatorName, video.title, video.description,
      video.tags, video.videoUrl, video.publishedAt, video.collectedAt, video.transcript, video.transcriptSource,
      status, analysis, video.error, video.createdAt, video.updatedAt);
  }
  if (tableExists(connection, "video_stock_views")) {
    const views = connection.prepare("SELECT * FROM video_stock_views").all() as LegacyViewRow[];
    const insertView = connection.prepare(`
      INSERT OR IGNORE INTO content_stock_views
        (id, contentId, platform, creatorId, creatorExternalId, creatorName, title, sourceUrl, publishedAt,
         collectedAt, symbols, companies, stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt)
      VALUES (?, ?, 'bilibili', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const view of views) {
      const content = connection.prepare("SELECT creatorId, collectedAt FROM content_items WHERE id = ?").get(view.videoId) as { creatorId: string; collectedAt: string } | undefined;
      if (!content) continue;
      insertView.run(view.id, view.videoId, content.creatorId, view.creatorMid, view.creatorName, view.title, view.videoUrl,
        view.publishedAt, content.collectedAt, view.symbols, view.companies, view.stance, view.coreView, view.evidence,
        view.risks, view.confidence, view.sourceSnippet, view.model, view.createdAt);
    }
  }
  connection.prepare("INSERT OR IGNORE INTO schema_migrations (name, appliedAt) VALUES (?, ?)")
    .run(legacyMediaMigration, new Date().toISOString());
}

function assertLegacyMediaCopied(connection: DatabaseSync) {
  if (tableExists(connection, "bilibili_videos")) {
    const missing = connection.prepare(`
      SELECT COUNT(*) AS count FROM bilibili_videos legacy
      LEFT JOIN content_items current ON current.id = legacy.id
      WHERE current.id IS NULL
    `).get() as { count: number };
    if (missing.count) throw new Error(`${missing.count} legacy Bilibili videos were not migrated.`);
  }
  if (tableExists(connection, "video_stock_views")) {
    const missing = connection.prepare(`
      SELECT COUNT(*) AS count FROM video_stock_views legacy
      LEFT JOIN content_stock_views current ON current.id = legacy.id
      WHERE current.id IS NULL
    `).get() as { count: number };
    if (missing.count) throw new Error(`${missing.count} legacy Bilibili views were not migrated.`);
  }
  if (tableExists(connection, "bilibili_creators")) {
    const missing = connection.prepare(`
      SELECT COUNT(*) AS count FROM bilibili_creators legacy
      LEFT JOIN creators current ON current.platform = 'bilibili' AND current.externalId = legacy.mid
      WHERE current.id IS NULL
    `).get() as { count: number };
    if (missing.count) throw new Error(`${missing.count} legacy Bilibili creators were not migrated.`);
  }
}

function applyLegacyRemoval(connection: DatabaseSync) {
  migrateLegacyMedia(connection);
  assertLegacyMediaCopied(connection);
  connection.exec(`
    DROP TABLE IF EXISTS research_suggestions;
    DROP TABLE IF EXISTS daily_summaries;
    DROP TABLE IF EXISTS video_stock_views;
    DROP TABLE IF EXISTS bilibili_videos;
    DROP TABLE IF EXISTS bilibili_creators;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS ai_runs;
  `);
}

function runMigration(connection: DatabaseSync, name: string, operation: (connection: DatabaseSync) => void) {
  if (applied(connection, name)) return;
  connection.exec("BEGIN IMMEDIATE");
  try {
    if (!applied(connection, name)) {
      operation(connection);
      connection.prepare("INSERT INTO schema_migrations (name, appliedAt) VALUES (?, ?)").run(name, new Date().toISOString());
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

function currentLegacyCounts(connection: DatabaseSync) {
  const counts: Record<string, number> = {};
  for (const table of legacyTables) {
    if (!tableExists(connection, table)) continue;
    counts[table] = Number((connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  }
  return counts;
}

async function verifiedLegacyBackup(connection: DatabaseSync): Promise<BackupVerification | null> {
  const counts = currentLegacyCounts(connection);
  if (!Object.keys(counts).length) return null;
  const requested = process.env.STOCKPULSE_MIGRATION_BACKUP_ID?.trim();
  const verified = requested
    ? await verifyBackup(requested, { maximumAgeMs: 60 * 60 * 1_000 })
    : await createVerifiedBackup({ reason: legacyRemovalMigration });
  const sourcePathHash = databaseSourceHash(databasePath());
  if (verified.manifest.sourcePathSha256 !== sourcePathHash) {
    throw new Error(`Backup ${verified.manifest.id} belongs to a different database path.`);
  }
  for (const [table, count] of Object.entries(counts)) {
    if (verified.manifest.tableCounts[table] !== count) {
      throw new Error(`Backup ${verified.manifest.id} does not match current ${table} row count.`);
    }
  }
  return verified;
}

export async function ensureDatabase() {
  await fsp.mkdir(databaseDirectory, { recursive: true });
  if (schemaReady) return;
  const connection = database();
  connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)");
  runMigration(connection, baseSchemaMigration, applyBaseSchema);
  runMigration(connection, operationsSchemaMigration, applyOperationsSchema);
  runMigration(connection, latestSchemaMigration, applyAnalysisModelSchema);
  if (!applied(connection, legacyRemovalMigration)) {
    await verifiedLegacyBackup(connection);
    runMigration(connection, legacyRemovalMigration, applyLegacyRemoval);
  }
  connection.exec("PRAGMA optimize");
  schemaReady = true;
}

export async function verifyDatabaseSchema() {
  await fsp.mkdir(databaseDirectory, { recursive: true });
  const problems = schemaProblems(database(), operationsSchemaMigration, latestSchemaMigration, legacyRemovalMigration);
  if (problems.length) throw new Error(`Database schema is not current (${problems.join(", ")}). Run npm run migrate first.`);
  schemaReady = true;
}
