import { ensureDatabase } from "./database/migrations.js";
import { log } from "./observability/logger.js";

await ensureDatabase();
log("info", "database_migrated");
