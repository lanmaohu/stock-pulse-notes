import type { CollectionRunTrigger, Platform } from "../shared/types.js";
import { analyzeContentStockViews } from "./ai.js";
import { decryptCredential } from "./credentials.js";
import {
  createCollectionRun,
  finishCollectionRun,
  finishCollectionRunItem,
  getCollectionRun,
  getCollectionSettings,
  getCreator,
  getNextQueuedCollectionRun,
  getPlatformAccountWithCredential,
  listCreators,
  markContentAnalysisStatus,
  recoverInterruptedCollectionRuns,
  saveContentStockViews,
  setCreatorEnabled,
  startCollectionRun,
  startCollectionRunItem,
  updateCreatorCollection,
  updatePlatformAccountStatus,
  upsertContent,
  upsertCreator
} from "./db.js";
import { platformAdapter } from "./platforms/index.js";
import { PlatformError } from "./platforms/types.js";

let workerRunning = false;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function platformCredential(platform: Platform) {
  const stored = getPlatformAccountWithCredential(platform);
  if (stored) {
    try {
      return { credential: decryptCredential(stored.encryptedCredential), accountId: stored.account.id };
    } catch {
      updatePlatformAccountStatus(stored.account.id, "error", { error: "平台登录凭证无法解密，请重新扫码绑定。" });
      throw new PlatformError("auth_required", "平台登录凭证无法解密，请重新扫码绑定。");
    }
  }
  const legacy = platform === "bilibili" ? process.env.BILIBILI_COOKIE?.trim() : "";
  if (legacy) {
    return { credential: legacy, accountId: undefined };
  }
  throw new PlatformError("auth_required", "请先绑定 B 站账号。");
}

function errorDetails(error: unknown) {
  if (error instanceof PlatformError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "analysis_failed",
    message: error instanceof Error ? error.message : "采集任务失败。"
  };
}

export async function checkPlatformAccount(platform: Platform) {
  const stored = getPlatformAccountWithCredential(platform);
  if (!stored) {
    throw new PlatformError("auth_required", "平台账号尚未绑定。");
  }
  updatePlatformAccountStatus(stored.account.id, "checking");
  try {
    const identity = await platformAdapter(platform).checkAccount(decryptCredential(stored.encryptedCredential));
    return updatePlatformAccountStatus(stored.account.id, "connected", identity);
  } catch (error) {
    const details = errorDetails(error);
    const status = details.code === "auth_required" ? "needs_reauth" : "error";
    updatePlatformAccountStatus(stored.account.id, status, { error: details.message });
    throw error;
  }
}

export async function searchPlatformCreators(platform: Platform, query: string) {
  const { credential } = platformCredential(platform);
  return platformAdapter(platform).searchCreators(query, credential);
}

export async function subscribeCreator(platform: Platform, externalId: string) {
  const { credential } = platformCredential(platform);
  const candidate = await platformAdapter(platform).resolveCreator(externalId, credential);
  const creator = upsertCreator(candidate);
  const { run } = createCollectionRun("subscription", [creator]);
  wakeCollectionWorker();
  return { creator, run };
}

export function updateCreatorSubscription(id: string, enabled: boolean) {
  return setCreatorEnabled(id, enabled);
}

export function enqueueCollection(trigger: CollectionRunTrigger, creatorIds?: string[], scheduledFor?: string) {
  const creators = listCreators({ enabledOnly: true, ids: creatorIds?.length ? creatorIds : undefined });
  if (!creators.length) {
    throw new Error("还没有启用的博主，请先添加博主。");
  }
  const result = createCollectionRun(trigger, creators, scheduledFor);
  if (result.created) {
    wakeCollectionWorker();
  }
  return result.run;
}

async function processCreator(
  runItem: NonNullable<ReturnType<typeof getCollectionRun>>["items"][number],
  contentLimit?: number
) {
  const creator = getCreator(runItem.creatorId);
  if (!creator || !creator.enabled) {
    finishCollectionRunItem(runItem.id, {
      status: "error",
      errorCode: "creator_not_found",
      error: "博主订阅已停用或不存在。"
    });
    return;
  }
  startCollectionRunItem(runItem.id);
  let discoveredCount = 0;
  let newContentCount = 0;
  let analyzedCount = 0;
  let analysisError = "";
  try {
    const { credential, accountId } = platformCredential(creator.platform);
    const adapter = platformAdapter(creator.platform);
    const settings = getCollectionSettings();
    const contentItems = await adapter.listCreatorContent(
      creator,
      credential,
      contentLimit ?? settings.maxVideosPerCreator
    );
    discoveredCount = contentItems.length;
    for (const input of contentItems) {
      const saved = upsertContent({
        ...input,
        platform: creator.platform,
        creatorId: creator.id,
        creatorExternalId: creator.externalId,
        creatorName: creator.name,
        error: input.warning
      });
      if (saved.isNew) {
        newContentCount += 1;
      }
      if (saved.content.analysisStatus !== "success") {
        try {
          markContentAnalysisStatus(saved.content.id, "running");
          const views = await analyzeContentStockViews(saved.content);
          saveContentStockViews(saved.content, views);
          analyzedCount += 1;
        } catch (error) {
          analysisError = error instanceof Error ? error.message : "投资观点分析失败。";
          markContentAnalysisStatus(saved.content.id, "error", analysisError);
        }
      }
    }
    updateCreatorCollection(creator.id, "success");
    if (accountId) {
      updatePlatformAccountStatus(accountId, "connected");
    }
    finishCollectionRunItem(runItem.id, {
      status: analysisError ? "error" : "success",
      discoveredCount,
      newContentCount,
      analyzedCount,
      errorCode: analysisError ? "analysis_failed" : undefined,
      error: analysisError || undefined
    });
  } catch (error) {
    const details = errorDetails(error);
    updateCreatorCollection(creator.id, "error", { error: details.message });
    const stored = getPlatformAccountWithCredential(creator.platform);
    if (stored && details.code === "auth_required") {
      updatePlatformAccountStatus(stored.account.id, "needs_reauth", { error: details.message });
    }
    finishCollectionRunItem(runItem.id, {
      status: "error",
      discoveredCount,
      newContentCount,
      analyzedCount,
      errorCode: details.code,
      error: details.message.slice(0, 1000)
    });
  }
}

async function processQueue() {
  if (workerRunning) {
    return;
  }
  workerRunning = true;
  try {
    let queued = getNextQueuedCollectionRun();
    while (queued) {
      const run = startCollectionRun(queued.id);
      if (!run) {
        queued = getNextQueuedCollectionRun();
        continue;
      }
      try {
        for (const item of run.items) {
          if (item.status !== "queued") {
            continue;
          }
          await processCreator(item, run.trigger === "subscription" ? 5 : undefined);
          if (run.items.length > 1) {
            await sleep(900);
          }
        }
        finishCollectionRun(run.id);
      } catch (error) {
        finishCollectionRun(run.id, error instanceof Error ? error.message : "采集任务意外中断。");
      }
      queued = getNextQueuedCollectionRun();
    }
  } finally {
    workerRunning = false;
  }
}

export function wakeCollectionWorker() {
  void processQueue().catch((error) => {
    console.error("Collection worker failed", error instanceof Error ? error.message : error);
  });
}

export function startCollectionWorker() {
  recoverInterruptedCollectionRuns();
  wakeCollectionWorker();
}
