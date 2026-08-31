import type { CollectionRun, Platform } from "../../shared/types.js";
import { analyzeContent } from "../ai.js";
import {
  finishCollectionRunItem,
  getCollectionSettings,
  startCollectionRunItem
} from "../repositories/collection.js";
import {
  markContentAnalysisStatus,
  resetContentAnalysis,
  saveContentAnalysis,
  upsertContent
} from "../repositories/content.js";
import {
  getCreator,
  getPlatformAccountWithCredential,
  updateCreatorCollection,
  updatePlatformAccountStatus
} from "../repositories/platform.js";
import { platformAdapter } from "../platforms/index.js";
import { collectionErrorDetails, platformCredential } from "./platform-service.js";
import { isCollectionCancellation, LeaseLostError } from "./errors.js";

type RunItem = CollectionRun["items"][number];

export interface ProcessCreatorOptions {
  leaseOwner: string;
  signal: AbortSignal;
  contentLimit?: number;
}

export interface CollectionProcessorDependencies {
  analyze: typeof analyzeContent;
  finishItem: typeof finishCollectionRunItem;
  settings: typeof getCollectionSettings;
  startItem: typeof startCollectionRunItem;
  markAnalysis: typeof markContentAnalysisStatus;
  resetAnalysis: typeof resetContentAnalysis;
  saveAnalysis: typeof saveContentAnalysis;
  upsertContent: typeof upsertContent;
  getCreator: typeof getCreator;
  getPlatformAccount: typeof getPlatformAccountWithCredential;
  updateCreator: typeof updateCreatorCollection;
  updatePlatformAccount: typeof updatePlatformAccountStatus;
  adapter: typeof platformAdapter;
  credential: typeof platformCredential;
}

const defaultDependencies: CollectionProcessorDependencies = {
  analyze: analyzeContent,
  finishItem: finishCollectionRunItem,
  settings: getCollectionSettings,
  startItem: startCollectionRunItem,
  markAnalysis: markContentAnalysisStatus,
  resetAnalysis: resetContentAnalysis,
  saveAnalysis: saveContentAnalysis,
  upsertContent,
  getCreator,
  getPlatformAccount: getPlatformAccountWithCredential,
  updateCreator: updateCreatorCollection,
  updatePlatformAccount: updatePlatformAccountStatus,
  adapter: platformAdapter,
  credential: platformCredential
};

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}

export function createCollectionProcessor(overrides: Partial<CollectionProcessorDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function processCreator(runItem: RunItem, options: ProcessCreatorOptions) {
    const { leaseOwner, signal } = options;
    const creator = dependencies.getCreator(runItem.creatorId);
    if (!creator || !creator.enabled) {
      const saved = dependencies.finishItem(runItem.id, {
        status: "error",
        errorCode: "creator_not_found",
        error: "博主订阅已停用或不存在。"
      }, leaseOwner);
      if (!saved) throw new LeaseLostError();
      return;
    }
    if (!dependencies.startItem(runItem.id, leaseOwner)) throw new LeaseLostError();

    let discoveredCount = 0;
    let newContentCount = 0;
    let analyzedCount = 0;
    const analysisErrors: string[] = [];
    try {
      const { credential, accountId } = dependencies.credential(creator.platform);
      const adapter = dependencies.adapter(creator.platform);
      const settings = dependencies.settings();
      const contentItems = await adapter.listCreatorContent(
        creator,
        credential,
        options.contentLimit ?? settings.maxVideosPerCreator,
        signal
      );
      assertActive(signal);
      discoveredCount = contentItems.length;
      for (const input of contentItems) {
        assertActive(signal);
        const saved = dependencies.upsertContent({
          ...input,
          platform: creator.platform,
          creatorId: creator.id,
          creatorExternalId: creator.externalId,
          creatorName: creator.name,
          error: input.warning
        });
        if (saved.isNew) newContentCount += 1;
        if (saved.content.analysisStatus !== "success") {
          dependencies.markAnalysis(saved.content.id, "running");
          try {
            const analysis = await dependencies.analyze(saved.content, { signal, model: settings.analysisModel });
            assertActive(signal);
            dependencies.saveAnalysis(saved.content, analysis);
            analyzedCount += 1;
          } catch (error) {
            if (isCollectionCancellation(error, signal)) {
              dependencies.resetAnalysis(saved.content.id);
              throw error;
            }
            const message = error instanceof Error ? error.message : "投资观点分析失败。";
            analysisErrors.push(message);
            dependencies.markAnalysis(saved.content.id, "error", message.slice(0, 1_000));
          }
        }
      }
      assertActive(signal);
      dependencies.updateCreator(creator.id, "success");
      if (accountId) dependencies.updatePlatformAccount(accountId, "connected");
      const summary = analysisErrors.length
        ? `${analysisErrors.length} 条内容分析失败：${analysisErrors[0]}`.slice(0, 1_000)
        : undefined;
      if (!dependencies.finishItem(runItem.id, {
        status: summary ? "error" : "success",
        discoveredCount,
        newContentCount,
        analyzedCount,
        errorCode: summary ? "analysis_failed" : undefined,
        error: summary
      }, leaseOwner)) throw new LeaseLostError();
    } catch (error) {
      if (isCollectionCancellation(error, signal)) throw error;
      const details = collectionErrorDetails(error);
      dependencies.updateCreator(creator.id, "error", { error: details.message });
      const stored = dependencies.getPlatformAccount(creator.platform as Platform);
      if (stored && details.code === "auth_required") {
        dependencies.updatePlatformAccount(stored.account.id, "needs_reauth", { error: details.message });
      }
      if (!dependencies.finishItem(runItem.id, {
        status: "error",
        discoveredCount,
        newContentCount,
        analyzedCount,
        errorCode: details.code,
        error: details.message.slice(0, 1_000)
      }, leaseOwner)) throw new LeaseLostError();
    }
  };
}

export const processCreator = createCollectionProcessor();
