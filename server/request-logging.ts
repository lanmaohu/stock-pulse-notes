import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { log } from "./observability/logger.js";

export function requestLogging(req: Request, res: Response, next: NextFunction) {
  const id = req.header("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.set("X-Request-Id", id);
  const requestPath = req.originalUrl.split("?", 1)[0];
  const startedAt = performance.now();
  res.on("finish", () => {
    log("info", "http_request", {
      requestId: id,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt)
    });
  });
  next();
}
