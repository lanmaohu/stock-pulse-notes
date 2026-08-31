import type { DatabaseSync } from "node:sqlite";

const requiredTables = [
  "schema_migrations",
  "auth_login_attempts",
  "platform_accounts",
  "creators",
  "content_items",
  "content_stock_views",
  "collection_runs",
  "collection_run_items",
  "collection_settings",
  "portfolio_snapshots",
  "portfolio_positions",
  "portfolio_cash_balances",
  "portfolio_fx_rates",
  "service_heartbeats"
] as const;

const requiredColumns: Record<string, string[]> = {
  content_items: ["platform", "externalId", "transcript", "transcriptSource", "summarySections", "analysisStatus"],
  content_stock_views: ["contentId", "model", "confidence", "sourceSnippet"],
  collection_runs: ["status", "leaseOwner", "leaseExpiresAt"],
  collection_run_items: ["runId", "status", "errorCode"],
  collection_settings: ["analysisModel"],
  portfolio_snapshots: ["status", "publishedAt"],
  service_heartbeats: ["serviceName", "instanceId", "status", "startedAt", "heartbeatAt"]
};

const requiredIndexes = [
  "idx_content_items_published",
  "idx_content_items_creator",
  "idx_content_views_content",
  "idx_collection_runs_scheduled",
  "idx_run_items_run",
  "idx_portfolio_single_draft",
  "idx_portfolio_published"
] as const;

export function schemaProblems(connection: DatabaseSync, ...migrationNames: string[]) {
  const problems: string[] = [];
  const objects = connection
    .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'index')")
    .all() as Array<{ name: string; type: "table" | "index" }>;
  const tables = new Set(objects.filter((item) => item.type === "table").map((item) => item.name));
  const indexes = new Set(objects.filter((item) => item.type === "index").map((item) => item.name));

  for (const table of requiredTables) {
    if (!tables.has(table)) problems.push(`missing table ${table}`);
  }
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!tables.has(table)) continue;
    const present = new Set(
      (connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    for (const column of columns) {
      if (!present.has(column)) problems.push(`missing column ${table}.${column}`);
    }
  }
  for (const index of requiredIndexes) {
    if (!indexes.has(index)) problems.push(`missing index ${index}`);
  }
  if (tables.has("schema_migrations")) {
    for (const migrationName of migrationNames) {
      const version = connection.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migrationName);
      if (!version) problems.push(`missing migration ${migrationName}`);
    }
  }
  return problems;
}
