import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { summarizeDate } from "./ai.js";
import { createBilibiliQrSession, pollBilibiliQrSession } from "./bilibili-auth.js";
import {
  checkPlatformAccount,
  enqueueCollection,
  searchPlatformCreators,
  startCollectionWorker,
  subscribeCreator,
  updateCreatorSubscription
} from "./collector.js";
import {
  createNote,
  deleteNote,
  deletePlatformAccount,
  ensureDatabase,
  getCollectionRun,
  getCollectionSettings,
  insertChatMessages,
  listBilibiliVideos,
  listChatMessages,
  listCollectionRuns,
  listContentInsights,
  listCreators,
  listDailySummaries,
  listNotes,
  listPlatformAccounts,
  listResearchSuggestions,
  listVideoStockViews,
  updateCollectionSettings,
  updateNote
} from "./db.js";
import { startCollectionScheduler } from "./scheduler.js";
import type {
  AuthSessionResponse,
  BilibiliVideosResponse,
  ChatMessagesResponse,
  CollectionRunsResponse,
  CollectionSettingsResponse,
  ContentInsightsResponse,
  CreatorSearchResponse,
  CreatorsResponse,
  DailySummariesResponse,
  HealthResponse,
  HermesMessageInput,
  HermesWebhookInput,
  LoginResponse,
  Note,
  NoteInput,
  NotesResponse,
  Platform,
  PlatformAccountsResponse,
  ResearchSuggestionsResponse,
  VideoStockViewsResponse
} from "../shared/types.js";

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const staticDir = path.join(process.cwd(), "dist");
const port = Number(process.env.PORT ?? 3000);
const tokenMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const sessionCookie = "stockpulse_session";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

function requireSecret(name: "NOTES_PASSWORD" | "SESSION_SECRET" | "WEBHOOK_TOKEN") {
  const value = name === "NOTES_PASSWORD" ? process.env.APP_PASSWORD || process.env.NOTES_PASSWORD : process.env[name];
  if (!value || value.includes("change-this") || value.includes("replace-with")) {
    throw new HttpError(500, `${name} is not configured.`);
  }
  return value;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signToken(payload: string) {
  return crypto.createHmac("sha256", requireSecret("SESSION_SECRET")).update(payload).digest("base64url");
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({ sub: "owner", exp: Date.now() + tokenMaxAgeMs })).toString("base64url");
  return `${payload}.${signToken(payload)}`;
}

function verifyToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signToken(payload), signature)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof body.exp === "number" && body.exp > Date.now();
  } catch {
    return false;
  }
}

function cookieValue(req: Request, name: string) {
  const header = req.header("cookie") || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return "";
}

function requestToken(req: Request) {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : cookieValue(req, sessionCookie);
}

function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (!verifyToken(requestToken(req))) throw new HttpError(401, "Unauthorized.");
  next();
}

function webhookMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!safeEqual(token, requireSecret("WEBHOOK_TOKEN"))) throw new HttpError(401, "Unauthorized webhook.");
  next();
}

function setSessionCookie(req: Request, res: Response, token: string) {
  const secure = req.secure || req.header("x-forwarded-proto") === "https";
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge: tokenMaxAgeMs,
    path: "/"
  });
}

function login(req: Request, res: Response) {
  const body = req.body as { password?: unknown };
  if (typeof body.password !== "string" || !safeEqual(body.password, requireSecret("NOTES_PASSWORD"))) {
    throw new HttpError(401, "密码不正确。");
  }
  const token = createToken();
  setSessionCookie(req, res, token);
  return token;
}

function routeParam(req: Request, name: string) {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function sanitizeInput(input: NoteInput) {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  const content = typeof input.content === "string" ? input.content.slice(0, 50000) : "";
  const pinned = typeof input.pinned === "boolean" ? input.pinned : false;
  const tags = Array.isArray(input.tags)
    ? input.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().replace(/\s+/g, " ").slice(0, 24))
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return { title: title || "未命名笔记", content, pinned, tags: Array.from(new Set(tags)) };
}

function normalizeWebhookInput(body: HermesWebhookInput): HermesMessageInput[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.sender === "string" && typeof body.content === "string") {
    return [{ externalId: body.externalId, source: body.source, sender: body.sender, content: body.content, messageAt: body.messageAt }];
  }
  throw new HttpError(400, "Webhook body must include messages[] or a single sender/content message.");
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "Date must be YYYY-MM-DD.");
}

function platformValue(value: unknown): Platform {
  if (value === "bilibili" || value === "douyin" || value === "xiaohongshu") return value;
  throw new HttpError(400, "不支持的平台。");
}

app.get("/api/health", (_req, res: Response<HealthResponse>) => {
  res.json({ ok: true, service: "stockpulse", storage: "sqlite" });
});

app.post("/api/auth/login", (req, res: Response<AuthSessionResponse>) => {
  login(req, res);
  res.json({ authenticated: true });
});

app.post("/api/login", (req, res: Response<LoginResponse>) => {
  res.json({ token: login(req, res) });
});

app.get("/api/auth/session", authMiddleware, (_req, res: Response<AuthSessionResponse>) => {
  res.json({ authenticated: true });
});

app.post("/api/auth/logout", (_req, res: Response<AuthSessionResponse>) => {
  res.clearCookie(sessionCookie, { path: "/" });
  res.json({ authenticated: false });
});

app.get("/api/platform-accounts", authMiddleware, (_req, res: Response<PlatformAccountsResponse>) => {
  res.json({ accounts: listPlatformAccounts() });
});

app.post("/api/platform-accounts/bilibili/qr", authMiddleware, async (_req, res, next) => {
  try {
    res.status(201).json(await createBilibiliQrSession());
  } catch (error) {
    next(new HttpError(502, error instanceof Error ? error.message : "无法生成 B 站登录二维码。"));
  }
});

app.get("/api/platform-accounts/bilibili/qr/:sessionId", authMiddleware, async (req, res, next) => {
  try {
    res.json(await pollBilibiliQrSession(routeParam(req, "sessionId")));
  } catch (error) {
    next(new HttpError(404, error instanceof Error ? error.message : "二维码会话不存在。"));
  }
});

app.post("/api/platform-accounts/:id/check", authMiddleware, async (req, res, next) => {
  const account = listPlatformAccounts().find((item) => item.id === routeParam(req, "id"));
  if (!account) throw new HttpError(404, "平台账号不存在。");
  try {
    res.json(await checkPlatformAccount(account.platform));
  } catch (error) {
    next(new HttpError(502, error instanceof Error ? error.message : "平台账号检查失败。"));
  }
});

app.delete("/api/platform-accounts/:id", authMiddleware, (req, res) => {
  if (!deletePlatformAccount(routeParam(req, "id"))) throw new HttpError(404, "平台账号不存在。");
  res.status(204).end();
});

app.get("/api/creators", authMiddleware, (_req, res: Response<CreatorsResponse>) => {
  res.json({ creators: listCreators() });
});

app.get("/api/creators/search", authMiddleware, async (req, res: Response<CreatorSearchResponse>, next) => {
  try {
    const platform = platformValue(req.query.platform);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    if (!query) throw new HttpError(400, "请输入博主名称、UID 或主页链接。");
    res.json({ candidates: await searchPlatformCreators(platform, query) });
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, error instanceof Error ? error.message : "博主搜索失败。"));
  }
});

app.post("/api/creators", authMiddleware, async (req, res, next) => {
  try {
    const platform = platformValue(req.body?.platform);
    const externalId = typeof req.body?.externalId === "string" ? req.body.externalId.trim().slice(0, 80) : "";
    if (!externalId) throw new HttpError(400, "缺少博主账号。");
    const result = await subscribeCreator(platform, externalId);
    res.status(201).json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, error instanceof Error ? error.message : "添加博主失败。"));
  }
});

app.patch("/api/creators/:id", authMiddleware, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean.");
  const creator = updateCreatorSubscription(routeParam(req, "id"), req.body.enabled);
  if (!creator) throw new HttpError(404, "博主不存在。");
  res.json(creator);
});

app.get("/api/content-insights", authMiddleware, (req, res: Response<ContentInsightsResponse>) => {
  const collectedDate = typeof req.query.collectedDate === "string" ? req.query.collectedDate : undefined;
  if (collectedDate) assertDate(collectedDate);
  const creatorId = typeof req.query.creatorId === "string" ? req.query.creatorId : undefined;
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : undefined;
  res.json({ insights: listContentInsights({ collectedDate, creatorId, query }) });
});

app.post("/api/collection-runs", authMiddleware, (req, res) => {
  const creatorIds = Array.isArray(req.body?.creatorIds)
    ? req.body.creatorIds.filter((id: unknown): id is string => typeof id === "string").slice(0, 100)
    : undefined;
  try {
    res.status(202).json(enqueueCollection("manual", creatorIds));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "无法创建采集任务。");
  }
});

app.get("/api/collection-runs", authMiddleware, (_req, res: Response<CollectionRunsResponse>) => {
  res.json({ runs: listCollectionRuns() });
});

app.get("/api/collection-runs/:id", authMiddleware, (req, res) => {
  const run = getCollectionRun(routeParam(req, "id"));
  if (!run) throw new HttpError(404, "采集任务不存在。");
  res.json(run);
});

app.get("/api/collection-settings", authMiddleware, (_req, res: Response<CollectionSettingsResponse>) => {
  res.json({ settings: getCollectionSettings() });
});

app.put("/api/collection-settings", authMiddleware, (req, res: Response<CollectionSettingsResponse>) => {
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : null;
  const localTime = typeof req.body?.localTime === "string" ? req.body.localTime : "";
  const maxVideosPerCreator = Number(req.body?.maxVideosPerCreator);
  const timeMatch = localTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (enabled === null || !timeMatch || !Number.isInteger(maxVideosPerCreator) || maxVideosPerCreator < 1 || maxVideosPerCreator > 20) {
    throw new HttpError(400, "采集设置格式不正确。");
  }
  res.json({ settings: updateCollectionSettings({ enabled, localTime, maxVideosPerCreator }) });
});

// Legacy research APIs remain available for one compatibility release.
app.get("/api/notes", authMiddleware, (_req, res: Response<NotesResponse>) => res.json({ notes: listNotes() }));
app.post("/api/notes", authMiddleware, (req: Request<unknown, Note, NoteInput>, res) => {
  res.status(201).json(createNote(sanitizeInput(req.body)));
});
app.put("/api/notes/:id", authMiddleware, (req: Request<{ id: string }, Note, NoteInput>, res) => {
  const updated = updateNote(req.params.id, sanitizeInput(req.body));
  if (!updated) throw new HttpError(404, "Note not found.");
  res.json(updated);
});
app.delete("/api/notes/:id", authMiddleware, (req, res) => {
  if (!deleteNote(routeParam(req, "id"))) throw new HttpError(404, "Note not found.");
  res.status(204).end();
});
app.post("/api/webhooks/hermes/messages", webhookMiddleware, (req: Request<unknown, unknown, HermesWebhookInput>, res) => {
  const inserted = insertChatMessages(normalizeWebhookInput(req.body));
  res.status(201).json({ inserted: inserted.length, messages: inserted });
});
app.get("/api/chat-messages", authMiddleware, (_req, res: Response<ChatMessagesResponse>) => {
  res.json({ messages: listChatMessages() });
});
app.get("/api/daily-summaries", authMiddleware, (_req, res: Response<DailySummariesResponse>) => {
  res.json({ summaries: listDailySummaries() });
});
app.post("/api/ai/summarize/:date", authMiddleware, async (req, res, next) => {
  const date = routeParam(req, "date");
  assertDate(date);
  try {
    res.json(await summarizeDate(date, { regenerate: req.query.regenerate === "true" }));
  } catch (error) {
    next(new HttpError(502, error instanceof Error ? error.message : "AI summary failed."));
  }
});
app.get("/api/research-suggestions", authMiddleware, (_req, res: Response<ResearchSuggestionsResponse>) => {
  res.json({ suggestions: listResearchSuggestions() });
});
app.get("/api/bilibili/videos", authMiddleware, (_req, res: Response<BilibiliVideosResponse>) => {
  res.json({ videos: listBilibiliVideos() });
});
app.get("/api/bilibili/stock-views", authMiddleware, (_req, res: Response<VideoStockViewsResponse>) => {
  res.json({ views: listVideoStockViews() });
});

app.use(express.static(staticDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next(new HttpError(404, "API route not found."));
  res.sendFile(path.join(staticDir, "index.html"));
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  res.status(status).json({ error: message });
});

app.listen(port, async () => {
  await ensureDatabase();
  startCollectionWorker();
  startCollectionScheduler();
  console.log(`Stockpulse API listening on http://localhost:${port}`);
});
