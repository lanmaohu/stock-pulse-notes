import type { CollectionRunTrigger, Platform } from "../../shared/types.js";
import { decryptCredential } from "../credentials.js";
import { createCollectionRun } from "../repositories/collection.js";
import {
  getPlatformAccountWithCredential,
  listCreators,
  setCreatorEnabled,
  updatePlatformAccountStatus,
  upsertCreator
} from "../repositories/platform.js";
import { platformAdapter } from "../platforms/index.js";
import { PlatformError } from "../platforms/types.js";
import { collectionErrorDetails, platformCredential } from "./platform-service.js";

export async function checkPlatformAccount(platform: Platform, signal?: AbortSignal) {
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
  const { credential } = platformCredential(platform);
  return platformAdapter(platform).searchCreators(query, credential, signal);
}

export async function subscribeCreator(platform: Platform, externalId: string, signal?: AbortSignal) {
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
  return createCollectionRun(trigger, creators, scheduledFor).run;
}
