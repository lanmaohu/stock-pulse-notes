import { Router, type Request, type Response } from "express";
import type {
  CollectionRunsResponse,
  CollectionSettingsResponse,
  CreatorSearchResponse,
  CreatorsResponse,
  PlatformAccountsResponse
} from "../../shared/types.js";
import { requireAdmin } from "../auth.js";
import { encryptCredential } from "../credentials.js";
import { cancelPlatformQrSession, createPlatformQrSession, pollPlatformQrSession } from "../platform-auth.js";
import {
  checkPlatformAccount,
  enqueueCollection,
  searchPlatformCreators,
  subscribeCreator,
  updateCreatorSubscription
} from "../collector.js";
import { deletePlatformAccount, listCreators, listPlatformAccounts, upsertPlatformAccount } from "../repositories/platform.js";
import { getCollectionRun, getCollectionSettings, listCollectionRuns, updateCollectionSettings } from "../repositories/collection.js";
import { HttpError } from "../http-error.js";
import { errorFields, log } from "../observability/logger.js";
import { PlatformError } from "../platforms/types.js";
import { twitterAdapter } from "../platforms/twitter.js";
import { completeTwitterOAuthSession, createTwitterOAuthSession } from "../twitter-auth.js";
import { platformValue, routeParam } from "../validation.js";

export const adminRouter = Router();
const protectedPrefixes = ["/platform-accounts", "/creators", "/collection-runs", "/collection-settings"];

function platformHttpError(error: unknown, fallbackMessage: string, fallbackCode: string) {
  if (!(error instanceof PlatformError)) {
    return new HttpError(502, error instanceof Error ? error.message : fallbackMessage, fallbackCode);
  }
  const status = error.code === "auth_required"
    ? 409
    : error.code === "rate_limited"
      ? 429
      : error.code === "browser_unavailable"
        ? 503
        : error.code === "creator_not_found" || error.code === "content_unavailable"
          ? 404
          : 502;
  return new HttpError(status, error.message, `PLATFORM_${error.code.toUpperCase()}`);
}

function requestAbort(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new PlatformError("platform_error", "请求已取消。"));
  };
  const close = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", close);
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort);
      res.off("close", close);
    }
  };
}

adminRouter.use((req, res, next) => {
  if (protectedPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
    return requireAdmin(req, res, next);
  }
  next();
});

adminRouter.get("/platform-accounts", (_req, res: Response<PlatformAccountsResponse>) => {
  res.json({ accounts: listPlatformAccounts() });
});

adminRouter.post("/platform-accounts/twitter/oauth", (_req, res, next) => {
  try {
    res.status(201).json(createTwitterOAuthSession());
  } catch (error) {
    next(platformHttpError(error, "无法开始 Twitter/X 授权。", "PLATFORM_OAUTH_FAILED"));
  }
});

function oauthReturnPage(res: Response, status: "connected" | "error" | "credits") {
  const target = `/admin/accounts?twitter=${status}`;
  res.status(200).set({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" }).send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Twitter/X 授权</title></head>
<body><p>${status === "connected" ? "Twitter/X 账号已绑定，正在返回管理后台…" : status === "credits" ? "Twitter/X API 额度不足，正在返回管理后台…" : "Twitter/X 授权失败，正在返回管理后台…"}</p>
<script>window.location.replace(${JSON.stringify(target)})</script><noscript><a href="${target}">返回管理后台</a></noscript></body></html>`);
}

adminRouter.get("/platform-oauth/twitter/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state.slice(0, 200) : "";
  const code = typeof req.query.code === "string" ? req.query.code.slice(0, 4_096) : "";
  if (!state || !code || req.query.error) return oauthReturnPage(res, "error");
  try {
    const credential = await completeTwitterOAuthSession(state, code);
    const identity = await twitterAdapter.checkAccount(credential);
    upsertPlatformAccount({
      platform: "twitter",
      externalUserId: identity.externalUserId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      encryptedCredential: encryptCredential(credential)
    });
    return oauthReturnPage(res, "connected");
  } catch (error) {
    const platformCode = error instanceof PlatformError ? error.code : "unknown";
    log("error", "twitter_oauth_callback_failed", { platformCode, ...errorFields(error) });
    return oauthReturnPage(res, platformCode === "rate_limited" ? "credits" : "error");
  }
});

adminRouter.post("/platform-accounts/:platform/qr", async (req, res, next) => {
  const request = requestAbort(req, res);
  try {
    const platform = platformValue(routeParam(req, "platform"));
    res.status(201).json(await createPlatformQrSession(platform, request.signal));
  } catch (error) {
    next(platformHttpError(error, "无法生成平台登录二维码。", "PLATFORM_QR_FAILED"));
  } finally {
    request.dispose();
  }
});

adminRouter.get("/platform-accounts/:platform/qr/:sessionId", async (req, res, next) => {
  const request = requestAbort(req, res);
  try {
    const platform = platformValue(routeParam(req, "platform"));
    res.json(await pollPlatformQrSession(platform, routeParam(req, "sessionId"), request.signal));
  } catch (error) {
    next(new HttpError(404, error instanceof Error ? error.message : "二维码会话不存在。", "QR_SESSION_NOT_FOUND"));
  } finally {
    request.dispose();
  }
});

adminRouter.delete("/platform-accounts/:platform/qr/:sessionId", async (req, res) => {
  const platform = platformValue(routeParam(req, "platform"));
  if (!await cancelPlatformQrSession(platform, routeParam(req, "sessionId"))) {
    throw new HttpError(404, "二维码会话不存在。", "QR_SESSION_NOT_FOUND");
  }
  res.status(204).end();
});

adminRouter.post("/platform-accounts/:id/check", async (req, res, next) => {
  const account = listPlatformAccounts().find((item) => item.id === routeParam(req, "id"));
  if (!account) throw new HttpError(404, "平台账号不存在。", "PLATFORM_ACCOUNT_NOT_FOUND");
  const request = requestAbort(req, res);
  try {
    res.json(await checkPlatformAccount(account.platform, request.signal));
  } catch (error) {
    next(platformHttpError(error, "平台账号检查失败。", "PLATFORM_CHECK_FAILED"));
  } finally {
    request.dispose();
  }
});

adminRouter.delete("/platform-accounts/:id", (req, res) => {
  if (!deletePlatformAccount(routeParam(req, "id"))) {
    throw new HttpError(404, "平台账号不存在。", "PLATFORM_ACCOUNT_NOT_FOUND");
  }
  res.status(204).end();
});

adminRouter.get("/creators", (_req, res: Response<CreatorsResponse>) => {
  res.json({ creators: listCreators() });
});

adminRouter.get("/creators/search", async (req, res: Response<CreatorSearchResponse>, next) => {
  const request = requestAbort(req, res);
  try {
    const platform = platformValue(req.query.platform);
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    if (!query) throw new HttpError(400, "请输入博主名称、UID 或主页链接。", "INVALID_CREATOR_QUERY");
    res.json({ candidates: await searchPlatformCreators(platform, query, request.signal) });
  } catch (error) {
    next(error instanceof HttpError ? error : platformHttpError(error, "博主搜索失败。", "CREATOR_SEARCH_FAILED"));
  } finally {
    request.dispose();
  }
});

adminRouter.post("/creators", async (req, res, next) => {
  const request = requestAbort(req, res);
  try {
    const platform = platformValue(req.body?.platform);
    const externalId = typeof req.body?.externalId === "string" ? req.body.externalId.trim().slice(0, 80) : "";
    if (!externalId) throw new HttpError(400, "缺少博主账号。", "INVALID_CREATOR");
    res.status(201).json(await subscribeCreator(platform, externalId, request.signal));
  } catch (error) {
    next(error instanceof HttpError ? error : platformHttpError(error, "添加博主失败。", "CREATOR_SUBSCRIBE_FAILED"));
  } finally {
    request.dispose();
  }
});

adminRouter.patch("/creators/:id", (req, res) => {
  if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean.", "INVALID_CREATOR_STATE");
  const creator = updateCreatorSubscription(routeParam(req, "id"), req.body.enabled);
  if (!creator) throw new HttpError(404, "博主不存在。", "CREATOR_NOT_FOUND");
  res.json(creator);
});

adminRouter.post("/collection-runs", (req, res) => {
  const creatorIds = Array.isArray(req.body?.creatorIds)
    ? req.body.creatorIds.filter((id: unknown): id is string => typeof id === "string").slice(0, 100)
    : undefined;
  try {
    res.status(202).json(enqueueCollection("manual", creatorIds));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "无法创建采集任务。", "COLLECTION_ENQUEUE_FAILED");
  }
});

adminRouter.get("/collection-runs", (_req, res: Response<CollectionRunsResponse>) => {
  res.json({ runs: listCollectionRuns() });
});

adminRouter.get("/collection-runs/:id", (req, res) => {
  const run = getCollectionRun(routeParam(req, "id"));
  if (!run) throw new HttpError(404, "采集任务不存在。", "COLLECTION_RUN_NOT_FOUND");
  res.json(run);
});

adminRouter.get("/collection-settings", (_req, res: Response<CollectionSettingsResponse>) => {
  res.json({ settings: getCollectionSettings() });
});

adminRouter.put("/collection-settings", (req, res: Response<CollectionSettingsResponse>) => {
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : null;
  const localTime = typeof req.body?.localTime === "string" ? req.body.localTime : "";
  const maxVideosPerCreator = Number(req.body?.maxVideosPerCreator);
  const timeMatch = localTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (enabled === null || !timeMatch || !Number.isInteger(maxVideosPerCreator) || maxVideosPerCreator < 1 || maxVideosPerCreator > 20) {
    throw new HttpError(400, "采集设置格式不正确。", "INVALID_COLLECTION_SETTINGS");
  }
  res.json({ settings: updateCollectionSettings({ enabled, localTime, maxVideosPerCreator }) });
});
