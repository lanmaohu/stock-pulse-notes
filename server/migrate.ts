import { ensureDatabase } from "./db.js";

await ensureDatabase();
console.log(JSON.stringify({ level: "info", event: "database_migrated" }));
