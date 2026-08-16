import { Router, type Response } from "express";
import type { ContentCreatorOptionsResponse, ContentInsightsResponse, HealthResponse } from "../../shared/types.js";
import { databaseIsHealthy } from "../db.js";
import { listContentCreatorOptions, listContentInsights } from "../repositories/content.js";
import { HttpError } from "../http-error.js";
import { assertDate, positiveIntegerQuery } from "../validation.js";

export const contentRouter = Router();

contentRouter.get("/health", (_req, res: Response<HealthResponse>) => {
  const ok = databaseIsHealthy();
  res.status(ok ? 200 : 503).json({ ok, service: "stockpulse", storage: "sqlite" });
});

contentRouter.get("/content-insights", (req, res: Response<ContentInsightsResponse>) => {
  const publishedDate = typeof req.query.publishedDate === "string" ? req.query.publishedDate : undefined;
  const collectedDate = typeof req.query.collectedDate === "string" ? req.query.collectedDate : undefined;
  if (publishedDate) assertDate(publishedDate);
  if (collectedDate) assertDate(collectedDate);
  const creatorId = typeof req.query.creatorId === "string" ? req.query.creatorId : undefined;
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : undefined;
  const page = positiveIntegerQuery(req.query.page, "page", 1);
  const pageSize = positiveIntegerQuery(req.query.pageSize, "pageSize", 10);
  if (pageSize !== 10 && pageSize !== 20 && pageSize !== 50) {
    throw new HttpError(400, "pageSize must be 10, 20, or 50.", "INVALID_PAGE_SIZE");
  }
  res.json(listContentInsights({ publishedDate, collectedDate, creatorId, query, page, pageSize }));
});

contentRouter.get("/content-creators", (_req, res: Response<ContentCreatorOptionsResponse>) => {
  res.json({ creators: listContentCreatorOptions() });
});
