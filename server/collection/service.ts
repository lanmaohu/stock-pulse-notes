import { isActivePlatform, type CollectionRunTrigger, type Platform } from "../../shared/types.js";
import { decryptCredential } from "../credentials.js";
import { createCollectionRun } from "../repositories/collection.js";
import {
  getPlatformAccountWithCredential,
  listCreators,
  listPlatformAccounts,
  setCreatorEnabled,
  updatePlatformAccountStatus,
  upsertCreator
} from "../repositories/platform.js";
import { platformAdapter } from "../platforms/index.js";
import { PlatformError } from "../platforms/types.js";
import { collectionErrorDetails, platformCredential } from "./platform-service.js";

function assertActivePlatform(platform: Platform) {
  if (!isActivePlatform(platform)) throw new PlatformError("platform_error", "该平台接入已下线。");
}

export async function checkPlatformAccount(platform: Platform, signal?: AbortSignal) {
  assertActivePlatform(platform);
  const stored = getPlatformAccountWithCredential(platform);
  if (!stored) throw new PlatformError("auth_required", "平台账号尚未绑定。");
  updatePlatformAccountStatus(stored.account.id, "checking");
  try {
    const identity = await platformAdapter(platform).checkAccount(decryptCredential(stored.encryptedCredential), signal);
    return updatePlatformAccountStatus(stored.account.id, "connected", identity);
  } catch (error) {
    const details = collectionErrorDetails(error);
    const status = details.code === "auth_required" ? "needs_reauth" : "error";
    updatePlatformAccountStatus(stored.account.id, status, { error: details.message });
    throw error;
  }
}

export async function searchPlatformCreators(platform: Platform, query: string, signal?: AbortSignal) {
  assertActivePlatform(platform);
  const { credential } = platformCredential(platform);
  return platformAdapter(platform).searchCreators(query, credential, signal);
}

export async function subscribeCreator(platform: Platform, externalId: string, signal?: AbortSignal) {
  assertActivePlatform(platform);
  const { credential } = platformCredential(platform);
  const candidate = await platformAdapter(platform).resolveCreator(externalId, credential, signal);
  const creator = upsertCreator(candidate);
  const { run } = createCollectionRun("subscription", [creator]);
  return { creator, run };
}

export function updateCreatorSubscription(id: string, enabled: boolean) {
  return setCreatorEnabled(id, enabled);
}

export function enqueueCollection(trigger: CollectionRunTrigger, creatorIds?: string[], scheduledFor?: string) {
  const creators = listCreators({ enabledOnly: true, ids: creatorIds?.length ? creatorIds : undefined });
  if (!creators.length) throw new Error("还没有启用的博主，请先添加博主。");
  const retired = creators.find((creator) => !isActivePlatform(creator.platform));
  if (creatorIds?.length && retired) throw new Error("该平台接入已下线，无法采集该博主。");
  const activeCreators = creators.filter((creator) => isActivePlatform(creator.platform));
  const connected = new Set(listPlatformAccounts().filter((account) => account.status === "connected").map((account) => account.platform));
  if (process.env.BILIBILI_COOKIE?.trim()) connected.add("bilibili");
  const eligible = activeCreators.filter((creator) => connected.has(creator.platform));
  if (creatorIds?.length && eligible.length !== activeCreators.length) {
    const unavailable = activeCreators.find((creator) => !connected.has(creator.platform));
    const label = unavailable?.platform === "bilibili"
      ? "B 站"
      : unavailable?.platform === "douyin"
        ? "抖音"
        : unavailable?.platform === "xiaohongshu"
          ? "小红书"
          : "平台";
    throw new Error(`${label}账号未连接，无法采集该博主。`);
  }
  if (!eligible.length) throw new Error("没有可采集的已连接平台博主。");
  return createCollectionRun(trigger, eligible, scheduledFor).run;
}
