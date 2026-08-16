// Migration implementation remains compatible with the original schema while callers use a dedicated boundary.
export { ensureDatabase, verifyDatabaseSchema } from "./legacy-store.js";
