// Compatibility facade for legacy imports. New application code imports domain repositories directly.
export * from "./database/legacy-store.js";
export { ensureDatabase, verifyDatabaseSchema } from "./database/migrations.js";
export { databaseIsHealthy } from "./database/health.js";
export { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "./repositories/auth.js";
export { insertChatMessages } from "./repositories/messages.js";
export {
  getContentItem,
  listContentCreatorOptions,
  listContentInsights,
  markContentAnalysisStatus,
  resetContentAnalysis,
  saveContentStockViews,
  upsertContent,
  type ContentInput,
  type ContentStockViewInput
} from "./repositories/content.js";
export {
  deletePlatformAccount,
  getCreator,
  getPlatformAccountWithCredential,
  listCreators,
  listPlatformAccounts,
  setCreatorEnabled,
  updateCreatorCollection,
  updatePlatformAccountStatus,
  upsertCreator,
  upsertPlatformAccount
} from "./repositories/platform.js";
export {
  claimNextQueuedCollectionRun,
  createCollectionRun,
  finishCollectionRun,
  finishCollectionRunItem,
  getCollectionRun,
  getCollectionSettings,
  getNextQueuedCollectionRun,
  listCollectionRuns,
  recoverInterruptedCollectionRuns,
  releaseCollectionRun,
  renewCollectionRunLease,
  startCollectionRunItem,
  updateCollectionSettings
} from "./repositories/collection.js";
export { getPortfolio, getPortfolioDraft, publishPortfolioDraft, savePortfolioDraft } from "./repositories/portfolio.js";
