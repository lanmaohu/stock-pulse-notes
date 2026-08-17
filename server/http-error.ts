import type { NextFunction, Request, Response } from "express";
import { log } from "./observability/logger.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED"
  ) {
    super(message);
  }
}

export function requestId(req: Request) {
  return (req as Request & { requestId?: string }).requestId || "unknown";
}

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const parserStatus = typeof error === "object" && error !== null && "status" in error && error.status === 400 ? 400 : undefined;
  const status = error instanceof HttpError ? error.status : parserStatus || 500;
  const code = error instanceof HttpError ? error.code : parserStatus ? "INVALID_JSON" : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  if (status >= 500) {
    log("error", "request_failed", { requestId: requestId(req), code, message: message.slice(0, 1_000) });
  }
  const publicMessage = error instanceof HttpError
    ? message
    : parserStatus
      ? "请求内容不是有效的 JSON。"
      : "服务器暂时无法处理请求。";
  res.status(status).json({ error: publicMessage, code, requestId: requestId(req) });
}
