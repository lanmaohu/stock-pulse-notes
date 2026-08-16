import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-db-test-"));
const databasePath = path.join(directory, "stockpulse.sqlite");
process.env.STOCKPULSE_DB_PATH = databasePath;

const legacy = new DatabaseSync(databasePath);
legacy.exec(`
  CREATE TABLE bilibili_creators (
    mid TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    lastCollectedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE bilibili_videos (
    id TEXT PRIMARY KEY, bvid TEXT NOT NULL UNIQUE, aid TEXT, cid TEXT, creatorMid TEXT NOT NULL,
    creatorName TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, tags TEXT NOT NULL,
    videoUrl TEXT NOT NULL, publishedAt TEXT NOT NULL, collectedAt TEXT NOT NULL, transcript TEXT NOT NULL,
    transcriptSource TEXT NOT NULL, status TEXT NOT NULL, summaryStatus TEXT NOT NULL DEFAULT 'pending',
    error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE video_stock_views (
    id TEXT PRIMARY KEY, videoId TEXT NOT NULL, bvid TEXT NOT NULL, creatorMid TEXT NOT NULL,
    creatorName TEXT NOT NULL, title TEXT NOT NULL, videoUrl TEXT NOT NULL, publishedAt TEXT NOT NULL,
    symbols TEXT NOT NULL, companies TEXT NOT NULL, stance TEXT NOT NULL, coreView TEXT NOT NULL,
    evidence TEXT NOT NULL, risks TEXT NOT NULL, confidence TEXT NOT NULL, sourceSnippet TEXT NOT NULL,
    model TEXT NOT NULL, createdAt TEXT NOT NULL
  );
`);
const timestamp = "2026-07-10T04:00:00.000Z";
legacy.prepare(`
  INSERT INTO bilibili_videos (
    id, bvid, aid, cid, creatorMid, creatorName, title, description, tags, videoUrl, publishedAt,
    collectedAt, transcript, transcriptSource, status, summaryStatus, error, createdAt, updatedAt
  ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
`).run(
  "legacy-video",
  "BV1legacy",
  "11473291",
  "笨笨的韭菜",
  "国产科技观点",
  "视频简介",
  JSON.stringify(["科技"]),
  "https://www.bilibili.com/video/BV1legacy",
  "2026-07-09T11:31:26.000Z",
  timestamp,
  "字幕内容",
  "subtitle",
  "ready",
  "success",
  timestamp,
  timestamp
);
legacy.prepare(`
  INSERT INTO video_stock_views (
    id, videoId, bvid, creatorMid, creatorName, title, videoUrl, publishedAt, symbols, companies,
    stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "legacy-view",
  "legacy-video",
  "BV1legacy",
  "11473291",
  "笨笨的韭菜",
  "国产科技观点",
  "https://www.bilibili.com/video/BV1legacy",
  "2026-07-09T11:31:26.000Z",
  "[]",
  JSON.stringify(["国产科技"]),
  "watch",
  "关注国产科技产业链",
  JSON.stringify(["视频字幕"]),
  JSON.stringify(["波动风险"]),
  "medium",
  "字幕内容",
  "test-model",
  timestamp
);
legacy.close();

const db = await import("./db.js");

test("legacy Bilibili data migrates once into the generic model", async () => {
  await db.ensureDatabase();
  await db.ensureDatabase();
  const read = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM creators").get() as { count: number }).count, 1);
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM content_items").get() as { count: number }).count, 1);
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM content_stock_views").get() as { count: number }).count, 1);
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '2026-08-stability-v1'").get() as { count: number }).count, 1);
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_content_items_published'").get() as { count: number }).count, 1);
  read.close();

  const insights = db.listContentInsights();
  assert.equal(insights.insights[0]?.content.creatorName, "笨笨的韭菜");
  assert.equal(insights.insights[0]?.views[0]?.coreView, "关注国产科技产业链");
});

test("creator subscriptions and scheduled runs are idempotent", () => {
  const creator = db.upsertCreator({
    platform: "bilibili",
    externalId: "11473291",
    name: "笨笨的韭菜",
    profileUrl: "https://space.bilibili.com/11473291"
  });
  const duplicate = db.upsertCreator({
    platform: "bilibili",
    externalId: "11473291",
    name: "笨笨的韭菜",
    profileUrl: "https://space.bilibili.com/11473291"
  });
  assert.equal(duplicate.id, creator.id);

  const first = db.createCollectionRun("scheduled", [creator], "2026-07-18");
  const second = db.createCollectionRun("scheduled", [creator], "2026-07-18");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id);
});

test("collection workers atomically claim each queued run once", () => {
  const claimed = db.claimNextQueuedCollectionRun();
  assert.ok(claimed);
  assert.equal(claimed.status, "running");
  assert.equal(db.claimNextQueuedCollectionRun(), null);
  assert.equal(db.getCollectionRun(claimed.id)?.status, "running");
  db.finishCollectionRun(claimed.id, "测试结束任务");
});

test("an active worker lease cannot be recovered or claimed by another worker", () => {
  const creator = db.listCreators()[0]!;
  const created = db.createCollectionRun("manual", [creator]).run;
  const leaseUntil = Date.now() + 60_000;
  assert.equal(db.claimNextQueuedCollectionRun("worker-a", leaseUntil)?.id, created.id);
  assert.equal(db.recoverInterruptedCollectionRuns(Date.now()), 0);
  assert.equal(db.claimNextQueuedCollectionRun("worker-b", Date.now() + 60_000), null);
  assert.equal(db.renewCollectionRunLease(created.id, "worker-a", Date.now() + 120_000), true);
  db.finishCollectionRun(created.id, "测试结束任务");
});

test("content insights mix content types and paginate by Shanghai publish time with full-result statistics", () => {
  const creator = db.upsertCreator({
    platform: "bilibili",
    externalId: "pagination-creator",
    name: "分页测试博主",
    profileUrl: "https://space.bilibili.com/pagination-creator"
  });
  const seeded = Array.from({ length: 13 }, (_, index) => {
    const publishedAt = index >= 10 ? "2026-08-15T12:00:00.000Z" : `2026-08-15T${String(index).padStart(2, "0")}:00:00.000Z`;
    const result = db.upsertContent({
      platform: "bilibili",
      externalId: `pagination-${index}`,
      creatorId: creator.id,
      creatorExternalId: creator.externalId,
      creatorName: creator.name,
      contentType: index % 2 ? "note" : "video",
      title: `分页内容 ${index}`,
      description: "分页与排序测试",
      tags: [],
      sourceUrl: `https://example.com/pagination-${index}`,
      publishedAt,
      transcript: "测试内容",
      transcriptSource: "metadata",
      status: "ready"
    });
    db.saveContentStockViews(result.content, [{
      symbols: ["TEST"],
      companies: [`公司${index}`],
      stance: "watch",
      coreView: `分页观点 ${index}`,
      evidence: [],
      risks: [],
      confidence: "medium",
      sourceSnippet: "",
      model: "test-model"
    }]);
    return result.content;
  });
  const writer = new DatabaseSync(databasePath);
  const updateCollected = writer.prepare("UPDATE content_items SET collectedAt = ? WHERE id = ?");
  for (const [index, content] of seeded.entries()) {
    const collectedHour = index >= 11 ? 12 : index;
    updateCollected.run(`2026-08-16T${String(collectedHour).padStart(2, "0")}:00:00.000Z`, content.id);
  }
  writer.close();

  const firstPage = db.listContentInsights({ publishedDate: "2026-08-15", creatorId: creator.id, page: 1, pageSize: 10 });
  assert.equal(firstPage.insights.length, 10);
  assert.equal(firstPage.pagination.totalItems, 13);
  assert.equal(firstPage.pagination.totalPages, 2);
  assert.deepEqual(firstPage.summary, { contentCount: 13, viewCount: 13, targetCount: 14 });
  const tiedIds = seeded.slice(11).sort((left, right) => left.id < right.id ? 1 : -1).map((content) => content.externalId);
  assert.deepEqual(firstPage.insights.slice(0, 3).map((item) => item.content.externalId), [...tiedIds, "pagination-10"]);
  assert.ok(firstPage.insights.some((item) => item.content.contentType === "video"));
  assert.ok(firstPage.insights.some((item) => item.content.contentType === "note"));

  const lastPage = db.listContentInsights({ publishedDate: "2026-08-15", creatorId: creator.id, page: 99, pageSize: 10 });
  assert.equal(lastPage.pagination.page, 2);
  assert.equal(lastPage.insights.length, 3);
  assert.deepEqual(lastPage.summary, firstPage.summary);

  const combinedFilter = db.listContentInsights({
    publishedDate: "2026-08-15",
    collectedDate: "2026-07-10",
    creatorId: creator.id,
    query: "分页内容 4",
    pageSize: 20
  });
  assert.equal(combinedFilter.pagination.totalItems, 1);
  assert.equal(combinedFilter.insights[0]?.content.externalId, "pagination-4");

  const empty = db.listContentInsights({ publishedDate: "2026-08-14", creatorId: creator.id, page: 50, pageSize: 50 });
  assert.deepEqual(empty.pagination, { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
  assert.deepEqual(empty.summary, { contentCount: 0, viewCount: 0, targetCount: 0 });
});

test("published-date filtering uses exact Asia/Shanghai day boundaries", () => {
  const creator = db.upsertCreator({
    platform: "bilibili",
    externalId: "boundary-creator",
    name: "边界测试博主",
    profileUrl: "https://space.bilibili.com/boundary-creator"
  });
  const timestamps = [
    "2026-08-14T15:59:59.999Z",
    "2026-08-14T16:00:00.000Z",
    "2026-08-15T15:59:59.999Z",
    "2026-08-15T16:00:00.000Z"
  ];
  for (const [index, publishedAt] of timestamps.entries()) {
    db.upsertContent({
      platform: "bilibili",
      externalId: `boundary-${index}`,
      creatorId: creator.id,
      creatorExternalId: creator.externalId,
      creatorName: creator.name,
      contentType: index % 2 ? "note" : "video",
      title: `边界内容 ${index}`,
      description: "",
      tags: [],
      sourceUrl: `https://example.com/boundary-${index}`,
      publishedAt,
      transcript: "",
      transcriptSource: "metadata",
      status: "ready"
    });
  }
  const result = db.listContentInsights({ publishedDate: "2026-08-15", creatorId: creator.id, pageSize: 10 });
  assert.deepEqual(result.insights.map((item) => item.content.externalId), ["boundary-2", "boundary-1"]);
});

test("interrupted runs resume only unfinished creator items", () => {
  const firstCreator = db.listCreators()[0]!;
  const secondCreator = db.upsertCreator({
    platform: "bilibili",
    externalId: "42",
    name: "第二个博主",
    profileUrl: "https://space.bilibili.com/42"
  });
  const created = db.createCollectionRun("manual", [firstCreator, secondCreator]).run;
  const running = db.startCollectionRun(created.id)!;
  db.startCollectionRunItem(running.items[0]!.id);
  db.finishCollectionRunItem(running.items[0]!.id, { status: "success", discoveredCount: 1 });
  db.startCollectionRunItem(running.items[1]!.id);

  db.recoverInterruptedCollectionRuns();
  const recovered = db.getCollectionRun(created.id)!;
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.items[0]!.status, "success");
  assert.equal(recovered.items[1]!.status, "queued");
});

test("portfolio snapshots calculate multi-currency allocation and redact sensitive data", () => {
  const initial = db.getPortfolioDraft();
  assert.deepEqual(initial.draft.fxRates.map((item) => item.currency).sort(), ["CNY", "HKD", "USD"]);

  db.savePortfolioDraft({
    ...initial.draft,
    title: "测试持仓全景图",
    subtitle: "多币种组合",
    ownerName: "测试用户",
    fxRates: [
      { currency: "CNY", rateToCny: 1 },
      { currency: "HKD", rateToCny: 0.92 },
      { currency: "USD", rateToCny: 7.2 }
    ],
    cashBalances: [
      { currency: "CNY", balance: 1000 },
      { currency: "HKD", balance: 0 },
      { currency: "USD", balance: 100 }
    ],
    positions: [
      {
        positionKey: "position-aapl",
        symbol: "AAPL",
        name: "Apple",
        assetType: "stock",
        market: "美股",
        sector: "科技",
        currency: "USD",
        quantity: 10,
        averageCost: 100,
        lastPrice: 120,
        sortOrder: 0
      },
      {
        positionKey: "position-hketf",
        symbol: "2800",
        name: "盈富基金",
        assetType: "etf",
        market: "港股",
        sector: "宽基",
        currency: "HKD",
        quantity: 100,
        averageCost: 10,
        lastPrice: 12,
        sortOrder: 1
      }
    ]
  });
  const published = db.publishPortfolioDraft();
  assert.ok(published.portfolio);
  assert.equal(published.portfolio!.summary.stockMarketValueCny, 9744);
  assert.equal(published.portfolio!.summary.cashMarketValueCny, 1720);
  assert.equal(published.portfolio!.summary.totalAssetsCny, 11464);
  assert.equal(Math.round(published.portfolio!.summary.unrealizedReturnPercent || 0), 20);

  const publicView = db.getPortfolio("public");
  assert.equal(publicView.portfolio?.title, "测试持仓全景图");
  assert.equal("quantity" in publicView.portfolio!.positions[0]!, false);
  assert.equal("totalAssetsCny" in publicView.portfolio!.summary, false);

  const firstSnapshotId = published.portfolio!.snapshotId;
  const nextDraft = db.getPortfolioDraft().draft;
  db.savePortfolioDraft({
    ...nextDraft,
    positions: nextDraft.positions.map((position) => position.symbol === "AAPL" ? { ...position, quantity: 12 } : position)
  });
  db.publishPortfolioDraft();
  const viewer = db.getPortfolio("viewer");
  const aapl = viewer.portfolio!.positions.find((position) => position.symbol === "AAPL")!;
  assert.equal(aapl.quantityChange, 2);

  const read = new DatabaseSync(databasePath, { readOnly: true });
  const original = read.prepare("SELECT quantity FROM portfolio_positions WHERE snapshotId = ? AND symbol = 'AAPL'").get(firstSnapshotId) as { quantity: number };
  assert.equal(original.quantity, 10);
  read.close();
});

test("portfolio draft validation rejects duplicates and unsafe image urls", () => {
  const draft = db.getPortfolioDraft().draft;
  assert.throws(() => db.savePortfolioDraft({
    ...draft,
    avatarUrl: "http://example.com/avatar.png"
  }), /HTTPS/);
  assert.throws(() => db.savePortfolioDraft({
    ...draft,
    positions: [...draft.positions, { ...draft.positions[0]!, positionKey: "duplicate-key" }]
  }), /重复持仓代码/);
});
