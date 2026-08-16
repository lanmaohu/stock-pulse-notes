import { app } from "./app.js";
import { apiPort, validateApiEnvironment } from "./config.js";
import { verifyDatabaseSchema } from "./db.js";

export { app } from "./app.js";

export async function startServer() {
  validateApiEnvironment();
  await verifyDatabaseSchema();
  const port = apiPort();
  return app.listen(port, () => {
    console.log(JSON.stringify({ level: "info", event: "api_started", port }));
  });
}
if (process.env.NODE_ENV !== "test") {
  void startServer().catch((error) => {
    console.error(JSON.stringify({
      level: "fatal",
      event: "api_start_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    process.exitCode = 1;
  });
}
