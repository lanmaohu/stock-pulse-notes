import { app } from "./app.js";
import { apiPort, validateApiEnvironment } from "./config.js";
import { closeDatabase } from "./database/connection.js";
import { verifyDatabaseSchema } from "./database/migrations.js";
import { errorFields, log } from "./observability/logger.js";
import { closePlatformQrSessions } from "./platform-auth.js";
import { closePlatformBrowsers } from "./platforms/browser.js";
import { closeTwitterOAuthSessions } from "./twitter-auth.js";
import type { Server } from "node:http";

export { app } from "./app.js";

export async function startServer() {
  validateApiEnvironment();
  await verifyDatabaseSchema();
  const port = apiPort();
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      log("info", "api_started", { port });
      if (typeof process.send === "function") process.send("ready");
      resolve(server);
    });
    server.once("error", reject);
  });
}

export async function stopServer(server: Server, timeoutMs = 10_000) {
  log("info", "api_stopping");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
  await closePlatformQrSessions();
  closeTwitterOAuthSessions();
  await closePlatformBrowsers();
  closeDatabase();
  log("info", "api_stopped");
}

if (process.env.NODE_ENV !== "test") {
  void startServer().then((server) => {
    let shuttingDown = false;
    const requestShutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void stopServer(server).catch((error) => {
        log("error", "api_shutdown_failed", errorFields(error));
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
  }).catch((error) => {
    log("fatal", "api_start_failed", errorFields(error));
    process.exitCode = 1;
  });
}
