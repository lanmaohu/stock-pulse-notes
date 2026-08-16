import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectionRun } from "../shared/types.js";
import { WorkerStoppedError } from "./collection/errors.js";
import { createCollectionProcessor } from "./collection/processor.js";
import { createCollectionScheduler } from "./scheduler.js";
import { createCollectionWorker } from "./workers/collection-worker.js";

const run: CollectionRun = {
  id: "run-1",
  trigger: "manual",
  status: "running",
  creatorCount: 1,
  discoveredCount: 0,
  newContentCount: 0,
  analyzedCount: 0,
  errorCount: 0,
  createdAt: "2026-08-16T00:00:00.000Z",
  items: [{
    id: "item-1",
    runId: "run-1",
    creatorId: "creator-1",
    creatorName: "测试博主",
    status: "queued",
    discoveredCount: 0,
    newContentCount: 0,
    analyzedCount: 0
  }]
};

test("worker cancellation releases its active run for another worker", async () => {
  let claimed = false;
  let released = false;
  let processingStarted = false;
  const worker = createCollectionWorker({
    pollIntervalMs: 60_000,
    claim: () => {
      if (claimed) return null;
      claimed = true;
      return run;
    },
    renew: () => true,
    release: (id) => {
      released = id === run.id;
      return true;
    },
    finish: () => run,
    recover: () => 0,
    processCreator: async (_item, options) => {
      processingStarted = true;
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
  });
  const stop = worker.start();
  while (!processingStarted) await new Promise((resolve) => setImmediate(resolve));
  await stop();
  assert.equal(released, true);
});

test("scheduler injects its clock and enqueues at most once per local day", () => {
  let enqueueCount = 0;
  const scheduler = createCollectionScheduler({
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    getSettings: () => ({
      enabled: true,
      localTime: "07:30",
      timezone: "Asia/Shanghai",
      maxVideosPerCreator: 5,
      updatedAt: "2026-08-16T00:00:00.000Z"
    }),
    enqueue: () => {
      enqueueCount += 1;
      return run;
    }
  });
  scheduler.tick();
  scheduler.tick();
  assert.equal(enqueueCount, 1);
});

test("worker stop reason is explicit and non-retryable by the processor", () => {
  assert.equal(new WorkerStoppedError().name, "WorkerStoppedError");
});

test("creator processing continues after one analysis failure and aggregates the item error", async () => {
  let analysisCalls = 0;
  let savedViews = 0;
  let finished: { status: "success" | "error"; analyzedCount?: number; error?: string } | undefined;
  const creator = {
    id: "creator-1",
    platform: "bilibili" as const,
    externalId: "100",
    name: "测试博主",
    profileUrl: "https://space.bilibili.com/100",
    enabled: true,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
  const collected = ["BV1", "BV2"].map((externalId) => ({
    externalId,
    contentType: "video" as const,
    title: externalId,
    description: "",
    tags: [],
    sourceUrl: `https://www.bilibili.com/video/${externalId}`,
    publishedAt: "2026-08-16T00:00:00.000Z",
    transcript: "字幕",
    transcriptSource: "subtitle" as const,
    status: "ready" as const
  }));
  const processor = createCollectionProcessor({
    getCreator: () => creator,
    startItem: () => true,
    credential: () => ({ credential: "cookie", accountId: undefined }),
    adapter: () => ({
      platform: "bilibili",
      checkAccount: async () => ({ externalUserId: "1", displayName: "test" }),
      searchCreators: async () => [],
      resolveCreator: async () => creator,
      listCreatorContent: async () => collected
    }),
    settings: () => ({
      enabled: true,
      localTime: "07:30",
      timezone: "Asia/Shanghai",
      maxVideosPerCreator: 5,
      updatedAt: "2026-08-16T00:00:00.000Z"
    }),
    upsertContent: (input) => ({
      isNew: true,
      content: {
        ...input,
        id: input.externalId,
        collectedAt: "2026-08-16T00:00:00.000Z",
        analysisStatus: "pending",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z"
      }
    }),
    markAnalysis: () => undefined,
    analyze: async () => {
      analysisCalls += 1;
      if (analysisCalls === 1) throw new Error("bad model output");
      return [];
    },
    saveViews: () => { savedViews += 1; },
    updateCreator: () => creator,
    finishItem: (_id, input) => {
      finished = input;
      return true;
    }
  });
  await processor(run.items[0]!, { leaseOwner: "worker", signal: new AbortController().signal });
  assert.equal(analysisCalls, 2);
  assert.equal(savedViews, 1);
  assert.equal(finished?.status, "error");
  assert.equal(finished?.analyzedCount, 1);
  assert.match(finished?.error || "", /1 条内容分析失败/);
});
