import { ensureDatabase } from "./database/migrations.js";

await ensureDatabase();
console.log(JSON.stringify({ level: "info", event: "database_migrated" }));
