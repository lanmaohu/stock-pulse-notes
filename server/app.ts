import express from "express";
import path from "node:path";
import { authRouter } from "./routes/auth.js";
import { contentRouter } from "./routes/content.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { adminRouter } from "./routes/admin.js";
import { webhookRouter } from "./routes/webhook.js";
import { errorMiddleware, HttpError } from "./http-error.js";
import { requestLogging } from "./request-logging.js";

const staticDir = path.join(process.cwd(), "dist");

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(requestLogging);
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", contentRouter);
  app.use("/api", authRouter);
  app.use("/api", portfolioRouter);
  app.use("/api", webhookRouter);
  app.use("/api", adminRouter);
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next(new HttpError(404, "API route not found.", "NOT_FOUND"));
    res.sendFile(path.join(staticDir, "index.html"));
  });
  app.use(errorMiddleware);
  return app;
}

export const app = createApp();
