import { validateWorkerEnvironment } from "./config.js";
import { startCollectionWorker } from "./collector.js";
import { closeDatabase } from "./database/connection.js";
import { verifyDatabaseSchema } from "./database/migrations.js";
import { errorFields, log } from "./observability/logger.js";
import { createBackupScheduler } from "./operations/backup-scheduler.js";
import { createServiceHeartbeat } from "./operations/heartbeat.js";
import { startCollectionScheduler } from "./scheduler.js";

async function startWorker() {
  validateWorkerEnvironment();
  await verifyDatabaseSchema();
  const heartbeat = createServiceHeartbeat("worker");
  heartbeat.start();
  const stopWorker = startCollectionWorker();
  const stopScheduler = startCollectionScheduler();
  const stopBackupScheduler = createBackupScheduler().start();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler();
    await Promise.all([stopBackupScheduler(), stopWorker()]);
    heartbeat.stop();
    closeDatabase();
    log("info", "worker_stopped");
  };
  const requestShutdown = () => {
    void shutdown().catch((error) => {
      log("error", "worker_shutdown_failed", errorFields(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  heartbeat.ready();
  log("info", "worker_started", { instanceId: heartbeat.instanceId });
  if (typeof process.send === "function") process.send("ready");
}

void startWorker().catch((error) => {
  log("fatal", "worker_start_failed", errorFields(error));
  process.exitCode = 1;
});
