import { validateWorkerEnvironment } from "./config.js";
import { startCollectionWorker } from "./collector.js";
import { verifyDatabaseSchema } from "./database/migrations.js";
import { startCollectionScheduler } from "./scheduler.js";

async function startWorker() {
  validateWorkerEnvironment();
  await verifyDatabaseSchema();
  const stopWorker = startCollectionWorker();
  const stopScheduler = startCollectionScheduler();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler();
    await stopWorker();
    console.log(JSON.stringify({ level: "info", event: "worker_stopping" }));
  };
  const requestShutdown = () => {
    void shutdown().catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "worker_shutdown_failed",
        message: error instanceof Error ? error.message : String(error)
      }));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  console.log(JSON.stringify({ level: "info", event: "worker_started" }));
}

void startWorker().catch((error) => {
  console.error(JSON.stringify({
    level: "fatal",
    event: "worker_start_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exitCode = 1;
});
