import { validateWorkerEnvironment } from "./config.js";
import { startCollectionWorker } from "./collector.js";
import { verifyDatabaseSchema } from "./db.js";
import { startCollectionScheduler } from "./scheduler.js";

async function startWorker() {
  validateWorkerEnvironment();
  await verifyDatabaseSchema();
  const stopWorker = startCollectionWorker();
  const stopScheduler = startCollectionScheduler();
  const shutdown = () => {
    stopScheduler();
    stopWorker();
    console.log(JSON.stringify({ level: "info", event: "worker_stopping" }));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
