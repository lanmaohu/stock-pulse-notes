import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-http-public-test-"));
process.env.STOCKPULSE_DB_PATH = path.join(directory, "stockpulse.sqlite");
process.env.STOCKPULSE_BACKUP_DIR = path.join(directory, "backups");
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token-with-sufficient-length";
process.env.PLATFORM_CREDENTIALS_KEY = Buffer.alloc(32, 19).toString("base64");
process.env.SESSION_SECRET = "test-session-secret-with-sufficient-length";
process.env.PORTFOLIO_VIEW_PASSWORD = "viewer-test-password";
process.env.PORTFOLIO_ADMIN_PASSWORD = "admin-test-password";

const { app } = await import("./index.js");
const { ensureDatabase } = await import("./database/migrations.js");
const { markContentAnalysisStatus, saveContentAnalysis, upsertContent } = await import("./repositories/content.js");
const { upsertCreator } = await import("./repositories/platform.js");
const { writeServiceHeartbeat } = await import("./repositories/operations.js");
const { createVerifiedBackup } = await import("./operations/backup.js");
const server = app.listen(0);
let baseUrl = "";
let seededCreatorId = "";
let retryableContentId = "";

before(async () => {
  await ensureDatabase();
  const creator = upsertCreator({
    platform: "bilibili",
    externalId: "api-pagination-creator",
    name: "接口分页博主",
    profileUrl: "https://space.bilibili.com/api-pagination-creator"
  });
  seededCreatorId = creator.id;
  const content = upsertContent({
    platform: "bilibili",
    externalId: "api-pagination-content",
    creatorId: creator.id,
    creatorExternalId: creator.externalId,
    creatorName: creator.name,
    contentType: "note",
    title: "接口分页测试内容",
    description: "组合筛选",
    tags: [],
    sourceUrl: "https://example.com/api-pagination-content",
    publishedAt: "2026-08-15T18:00:00.000Z",
    transcript: "接口分页测试",
    transcriptSource: "metadata",
    status: "ready"
  }).content;
  saveContentAnalysis(content, { summarySections: [], views: [{
    symbols: ["API"],
    companies: [],
    stance: "watch",
    coreView: "接口观点",
    evidence: [],
    risks: [],
    confidence: "medium",
    sourceSnippet: "",
    model: "test-model"
  }] });
  const retryableContent = upsertContent({
    platform: "bilibili",
    externalId: "api-retryable-content",
    creatorId: creator.id,
    creatorExternalId: creator.externalId,
    creatorName: creator.name,
    contentType: "video",
    title: "可手动重试内容",
    description: "",
    tags: [],
    sourceUrl: "https://example.com/api-retryable-content",
    publishedAt: "2026-08-14T18:00:00.000Z",
    transcript: "",
    transcriptSource: "metadata",
    status: "metadata_only"
  }).content;
  retryableContentId = retryableContent.id;
  markContentAnalysisStatus(retryableContentId, "error", "DeepSeek returned an empty response.");
  const now = new Date().toISOString();
  writeServiceHeartbeat({ serviceName: "worker", instanceId: "http-test-worker", status: "ready", startedAt: now, heartbeatAt: now });
  await createVerifiedBackup({ reason: "http-test" });
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("public APIs stay available while management reads require an administrator", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);

  const live = await fetch(`${baseUrl}/api/health/live`);
  assert.equal(live.status, 200);
  assert.equal((await live.json() as { release: string }).release, "development");

  const ready = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as { checks: { worker: string; backup: string } }).checks.worker, "ok");

  const insights = await fetch(`${baseUrl}/api/content-insights`);
  assert.equal(insights.status, 200);
  const insightsBody = await insights.json() as {
    insights: Array<{ content: { summarySections: unknown[] } }>;
    pagination: { page: number; pageSize: number };
    summary: { contentCount: number };
  };
  assert.equal(insightsBody.insights.length, 2);
  assert.deepEqual(insightsBody.insights[0]?.content.summarySections, []);
  assert.deepEqual(insightsBody.pagination, { page: 1, pageSize: 10, totalItems: 2, totalPages: 1 });
  assert.equal(insightsBody.summary.contentCount, 2);

  const contentCreators = await fetch(`${baseUrl}/api/content-creators`);
  assert.equal(contentCreators.status, 200);
  const creatorOptions = (await contentCreators.json() as { creators: Array<Record<string, unknown>> }).creators;
  assert.equal(creatorOptions.length, 1);
  assert.deepEqual(Object.keys(creatorOptions[0]!).sort(), ["id", "name", "platform"]);

  for (const path of ["/api/platform-accounts", "/api/creators", "/api/collection-runs", "/api/collection-settings"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, path);
  }

  const unknownApi = await fetch(`${baseUrl}/api/not-a-real-route`);
  assert.equal(unknownApi.status, 404);

  for (const path of [
    "/api/login",
    "/api/notes",
    "/api/chat-messages",
    "/api/daily-summaries",
    "/api/ai/summarize/2026-08-16",
    "/api/research-suggestions",
    "/api/bilibili/videos",
    "/api/bilibili/stock-views"
  ]) {
    const retired = await fetch(`${baseUrl}${path}`);
    assert.equal(retired.status, 404, path);
  }
});

test("content insights API validates pagination and combines published-date filters", async () => {
  for (const pageSize of [10, 20, 50]) {
    const response = await fetch(`${baseUrl}/api/content-insights?page=1&pageSize=${pageSize}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { pagination: { pageSize: number } }).pagination.pageSize, pageSize);
  }

  const filtered = await fetch(`${baseUrl}/api/content-insights?publishedDate=2026-08-16&collectedDate=2020-01-01&q=API&creatorId=${encodeURIComponent(seededCreatorId)}`);
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json() as { pagination: { totalItems: number } }).pagination.totalItems, 1);

  for (const query of ["page=0", "page=-1", "page=1.5", "pageSize=12", "publishedDate=not-a-date", "publishedDate=2026-02-31"]) {
    const response = await fetch(`${baseUrl}/api/content-insights?${query}`);
    assert.equal(response.status, 400, query);
  }
});

test("error responses include a stable code and request ID without exposing parser details", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": "test-invalid-json" },
    body: "{invalid"
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-request-id"), "test-invalid-json");
  assert.deepEqual(await response.json(), {
    error: "请求内容不是有效的 JSON。",
    code: "INVALID_JSON",
    requestId: "test-invalid-json"
  });
});

test("workspace administrator login shares the portfolio administrator session", async () => {
  const anonymousSession = await fetch(`${baseUrl}/api/auth/session`);
  assert.deepEqual(await anonymousSession.json(), { authenticated: false });

  const wrong = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.40" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.PORTFOLIO_ADMIN_PASSWORD })
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: true });
  const adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: adminCookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });

  const portfolioSession = await fetch(`${baseUrl}/api/portfolio/session`, { headers: { cookie: adminCookie } });
  assert.deepEqual(await portfolioSession.json(), { accessLevel: "admin" });

  for (const path of ["/api/platform-accounts", "/api/creators", "/api/collection-runs", "/api/collection-settings"]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: adminCookie } });
    assert.equal(response.status, 200, path);
    if (path === "/api/platform-accounts") assert.equal(response.headers.get("cache-control"), "no-store");
  }

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { authenticated: false });
});

test("administrator can select an analysis model and legacy updates preserve it", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.PORTFOLIO_ADMIN_PASSWORD })
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { "Content-Type": "application/json", cookie: adminCookie };

  const initial = await fetch(`${baseUrl}/api/collection-settings`, { headers: { cookie: adminCookie } });
  const initialSettings = (await initial.json() as { settings: { analysisModel: string } }).settings;
  assert.equal(initialSettings.analysisModel, "deepseek-v4-pro");

  const selected = await fetch(`${baseUrl}/api/collection-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, localTime: "07:30", maxVideosPerCreator: 5, analysisModel: "deepseek-v4-flash" })
  });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json() as { settings: { analysisModel: string } }).settings.analysisModel, "deepseek-v4-flash");

  const legacyUpdate = await fetch(`${baseUrl}/api/collection-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, localTime: "08:15", maxVideosPerCreator: 6 })
  });
  const legacySettings = (await legacyUpdate.json() as { settings: { analysisModel: string; localTime: string } }).settings;
  assert.equal(legacyUpdate.status, 200);
  assert.equal(legacySettings.analysisModel, "deepseek-v4-flash");
  assert.equal(legacySettings.localTime, "08:15");

  const invalid = await fetch(`${baseUrl}/api/collection-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, localTime: "07:30", maxVideosPerCreator: 5, analysisModel: "deepseek-v4-invalid" })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code: string }).code, "INVALID_COLLECTION_SETTINGS");

  const restore = await fetch(`${baseUrl}/api/collection-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, localTime: "07:30", maxVideosPerCreator: 5, analysisModel: "deepseek-v4-pro" })
  });
  assert.equal(restore.status, 200);
});

test("every management operation rejects anonymous and viewer sessions before handling input", async () => {
  const protectedRequests: Array<[string, RequestInit?]> = [
    ["/api/platform-accounts"],
    ["/api/platform-accounts/bilibili/qr", { method: "POST" }],
    ["/api/platform-accounts/twitter/oauth", { method: "POST" }],
    ["/api/platform-accounts/bilibili/qr/missing"],
    ["/api/platform-accounts/douyin/qr/missing", { method: "DELETE" }],
    ["/api/platform-accounts/missing/check", { method: "POST" }],
    ["/api/platform-accounts/missing", { method: "DELETE" }],
    ["/api/creators"],
    ["/api/creators/search?platform=bilibili&q=test"],
    ["/api/creators", { method: "POST" }],
    ["/api/creators/missing", { method: "PATCH" }],
    ["/api/collection-runs", { method: "POST" }],
    ["/api/collection-runs"],
    ["/api/collection-runs/missing"],
    ["/api/collection-settings"],
    ["/api/collection-settings", { method: "PUT" }],
    ["/api/content-items/missing/analysis-retry", { method: "POST" }]
  ];
  for (const [path, init] of protectedRequests) {
    const response = await fetch(`${baseUrl}${path}`, init);
    assert.equal(response.status, 401, `${init?.method || "GET"} ${path}`);
  }

  const oauthCallback = await fetch(`${baseUrl}/api/platform-oauth/twitter/callback?error=access_denied`);
  assert.equal(oauthCallback.status, 404);

  const viewerLogin = await fetch(`${baseUrl}/api/portfolio/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "viewer", password: process.env.PORTFOLIO_VIEW_PASSWORD })
  });
  const viewerCookie = viewerLogin.headers.get("set-cookie")!.split(";")[0]!;
  for (const path of ["/api/platform-accounts", "/api/creators", "/api/collection-runs", "/api/collection-settings"]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: viewerCookie } });
    assert.equal(response.status, 403, path);
  }
  const viewerRetry = await fetch(`${baseUrl}/api/content-items/${retryableContentId}/analysis-retry`, { method: "POST", headers: { cookie: viewerCookie } });
  assert.equal(viewerRetry.status, 403);
});

test("an administrator can retry one failed content analysis and cannot submit it twice", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.PORTFOLIO_ADMIN_PASSWORD })
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const retry = await fetch(`${baseUrl}/api/content-items/${retryableContentId}/analysis-retry`, { method: "POST", headers: { cookie } });
  assert.equal(retry.status, 200);
  const insight = await retry.json() as { content: { id: string; analysisStatus: string; error?: string }; views: unknown[] };
  assert.equal(insight.content.id, retryableContentId);
  assert.equal(insight.content.analysisStatus, "success");
  assert.equal(insight.content.error, undefined);
  assert.deepEqual(insight.views, []);

  const duplicate = await fetch(`${baseUrl}/api/content-items/${retryableContentId}/analysis-retry`, { method: "POST", headers: { cookie } });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { code: string }).code, "CONTENT_ANALYSIS_NOT_RETRYABLE");
});

test("webhook keeps its independent bearer-token boundary", async () => {
  const missingToken = await fetch(`${baseUrl}/api/webhooks/hermes/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "test", content: "test" })
  });
  assert.equal(missingToken.status, 401);
});

test("portfolio data is only available to administrators", async () => {
  const initial = await fetch(`${baseUrl}/api/portfolio`);
  assert.equal(initial.status, 401);

  const viewerLogin = await fetch(`${baseUrl}/api/portfolio/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "viewer", password: process.env.PORTFOLIO_VIEW_PASSWORD })
  });
  assert.equal(viewerLogin.status, 200);
  const viewerCookie = viewerLogin.headers.get("set-cookie")!.split(";")[0]!;
  const viewerPortfolio = await fetch(`${baseUrl}/api/portfolio`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerPortfolio.status, 403);
  const viewerDraft = await fetch(`${baseUrl}/api/portfolio/admin/draft`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerDraft.status, 403);

  const adminLogin = await fetch(`${baseUrl}/api/portfolio/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin", password: process.env.PORTFOLIO_ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0]!;
  const draftResponse = await fetch(`${baseUrl}/api/portfolio/admin/draft`, { headers: { cookie: adminCookie } });
  assert.equal(draftResponse.status, 200);
  const draftBody = await draftResponse.json() as { draft: Record<string, unknown> };
  const save = await fetch(`${baseUrl}/api/portfolio/admin/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      ...draftBody.draft,
      fxRates: [{ currency: "CNY", rateToCny: 1 }, { currency: "HKD", rateToCny: 0.9 }, { currency: "USD", rateToCny: 7 }],
      cashBalances: [{ currency: "CNY", balance: 1000 }, { currency: "HKD", balance: 0 }, { currency: "USD", balance: 0 }],
      positions: [{
        positionKey: "api-position-aapl",
        symbol: "AAPL",
        name: "Apple",
        assetType: "stock",
        market: "美股",
        sector: "科技",
        currency: "USD",
        quantity: 2,
        averageCost: 100,
        lastPrice: 110,
        sortOrder: 0
      }]
    })
  });
  assert.equal(save.status, 200);
  const publish = await fetch(`${baseUrl}/api/portfolio/admin/publish`, { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(publish.status, 201);

  const publicResponse = await fetch(`${baseUrl}/api/portfolio`);
  assert.equal(publicResponse.status, 401);
  const viewerResponse = await fetch(`${baseUrl}/api/portfolio`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerResponse.status, 403);
  const adminResponse = await fetch(`${baseUrl}/api/portfolio`, { headers: { cookie: adminCookie } });
  const adminBody = await adminResponse.json() as { accessLevel: string; portfolio: { positions: Array<Record<string, unknown>> } };
  assert.equal(adminResponse.status, 200);
  assert.equal(adminBody.accessLevel, "admin");
  assert.equal(adminBody.portfolio.positions[0]!.quantity, 2);

  const logout = await fetch(`${baseUrl}/api/portfolio/session`, { method: "DELETE", headers: { cookie: adminCookie } });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { accessLevel: "public" });
});

test("portfolio sessions reject expired signatures and rate-limit repeated failures", async () => {
  const payload = Buffer.from(JSON.stringify({ aud: "portfolio", role: "admin", exp: Date.now() - 1000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  const expiredCookie = `stockpulse_portfolio_session=${payload}.${signature}`;
  const expired = await fetch(`${baseUrl}/api/portfolio/session`, { headers: { cookie: expiredCookie } });
  assert.deepEqual(await expired.json(), { accessLevel: "public" });
  const expiredAdmin = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: expiredCookie } });
  assert.deepEqual(await expiredAdmin.json(), { authenticated: false });

  const tamperedCookie = `stockpulse_portfolio_session=${payload}.${signature}x`;
  const tampered = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: tamperedCookie } });
  assert.deepEqual(await tampered.json(), { authenticated: false });
  const tamperedSettings = await fetch(`${baseUrl}/api/collection-settings`, { headers: { cookie: tamperedCookie } });
  assert.equal(tamperedSettings.status, 401);

  for (let index = 0; index < 5; index += 1) {
    const failed = await fetch(`${baseUrl}/api/portfolio/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.22" },
      body: JSON.stringify({ role: "viewer", password: "wrong-password" })
    });
    assert.equal(failed.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/portfolio/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.22" },
    body: JSON.stringify({ role: "viewer", password: "wrong-password" })
  });
  assert.equal(limited.status, 429);
});

test("changing the administrator password invalidates existing signed sessions", async () => {
  const previousPassword = process.env.PORTFOLIO_ADMIN_PASSWORD!;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.44" },
    body: JSON.stringify({ password: previousPassword })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];

  process.env.PORTFOLIO_ADMIN_PASSWORD = "rotated-admin-test-password";
  try {
    const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
    assert.deepEqual(await session.json(), { authenticated: false });
    const protectedResponse = await fetch(`${baseUrl}/api/collection-settings`, { headers: { cookie } });
    assert.equal(protectedResponse.status, 401);
    const relogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.44" },
      body: JSON.stringify({ password: "rotated-admin-test-password" })
    });
    assert.equal(relogin.status, 200);
  } finally {
    process.env.PORTFOLIO_ADMIN_PASSWORD = previousPassword;
  }
});
