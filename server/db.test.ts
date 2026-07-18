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
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 1);
  read.close();

  const insights = db.listContentInsights();
  assert.equal(insights[0]?.content.creatorName, "笨笨的韭菜");
  assert.equal(insights[0]?.views[0]?.coreView, "关注国产科技产业链");
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
