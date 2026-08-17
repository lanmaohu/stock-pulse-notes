import { database } from "./connection.js";
import { latestSchemaMigration, legacyRemovalMigration } from "./migrations.js";
import { schemaProblems } from "./schema.js";
import { latestBackup } from "../operations/backup.js";
import { collectionQueueHealth, getServiceHeartbeat } from "../repositories/operations.js";

export function databaseIsHealthy() {
  try {
    return (database().prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export async function readinessStatus(now = Date.now()) {
  let databaseStatus: "ok" | "error" = "error";
  let schemaStatus: "ok" | "error" = "error";
  let workerStatus: "ok" | "missing" | "stale" = "missing";
  let queue = { queued: 0, running: 0, oldestQueuedAt: undefined as string | undefined, expiredLeases: 0 };
  try {
    databaseStatus = databaseIsHealthy() ? "ok" : "error";
    if (databaseStatus === "ok") {
      schemaStatus = schemaProblems(database(), latestSchemaMigration, legacyRemovalMigration).length ? "error" : "ok";
      const heartbeat = getServiceHeartbeat("worker");
      if (heartbeat) {
        const age = now - Date.parse(heartbeat.heartbeatAt);
        workerStatus = heartbeat.status === "ready" && age >= 0 && age <= 90_000 ? "ok" : "stale";
      }
      queue = collectionQueueHealth(now);
    }
  } catch {
    databaseStatus = "error";
  }

  let backupStatus: "ok" | "missing" | "stale" = "missing";
  let latestBackupAt: string | undefined;
  try {
    const latest = await latestBackup();
    if (latest) {
      latestBackupAt = latest.manifest.createdAt;
      const age = now - Date.parse(latestBackupAt);
      backupStatus = age >= 0 && age <= 36 * 60 * 60 * 1_000 ? "ok" : "stale";
    }
  } catch {
    backupStatus = "missing";
  }

  const checks = { database: databaseStatus, schema: schemaStatus, worker: workerStatus, backup: backupStatus };
  return {
    ok: Object.values(checks).every((value) => value === "ok"),
    checks,
    queue,
    latestBackupAt
  };
}
