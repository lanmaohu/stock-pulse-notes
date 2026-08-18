import { Router, type Request, type Response } from "express";
import type {
  PortfolioDraft,
  PortfolioDraftResponse,
  PortfolioResponse,
  PortfolioSessionResponse
} from "../../shared/types.js";
import { accessLevel, authenticate, clearSession, requireAdmin } from "../auth.js";
import { getPortfolio, getPortfolioDraft, publishPortfolioDraft, savePortfolioDraft } from "../repositories/portfolio.js";
import { HttpError } from "../http-error.js";

export const portfolioRouter = Router();

portfolioRouter.get("/portfolio", requireAdmin, (req, res: Response<PortfolioResponse>) => {
  res.set("Cache-Control", "private, no-store");
  res.vary("Cookie");
  res.json(getPortfolio(accessLevel(req)));
});

portfolioRouter.get("/portfolio/session", (req, res: Response<PortfolioSessionResponse>) => {
  res.set("Cache-Control", "private, no-store");
  res.vary("Cookie");
  res.json({ accessLevel: accessLevel(req) });
});

portfolioRouter.post("/portfolio/session", (req, res: Response<PortfolioSessionResponse>) => {
  const role = req.body?.role;
  if (role !== "viewer" && role !== "admin") throw new HttpError(400, "登录信息不完整。", "INVALID_LOGIN");
  authenticate(req, res, role, req.body?.password);
  res.json({ accessLevel: role });
});

portfolioRouter.delete("/portfolio/session", (_req, res: Response<PortfolioSessionResponse>) => {
  clearSession(res);
  res.json({ accessLevel: "public" });
});

portfolioRouter.get("/portfolio/admin/draft", requireAdmin, (_req, res: Response<PortfolioDraftResponse>) => {
  res.set("Cache-Control", "private, no-store");
  res.json(getPortfolioDraft());
});

portfolioRouter.put("/portfolio/admin/draft", requireAdmin, (req: Request<unknown, PortfolioDraftResponse, PortfolioDraft>, res, next) => {
  try {
    res.json(savePortfolioDraft(req.body));
  } catch (error) {
    next(new HttpError(400, error instanceof Error ? error.message : "持仓草稿保存失败。", "INVALID_PORTFOLIO_DRAFT"));
  }
});

portfolioRouter.post("/portfolio/admin/publish", requireAdmin, (_req, res: Response<PortfolioResponse>, next) => {
  try {
    res.status(201).json(publishPortfolioDraft());
  } catch (error) {
    next(new HttpError(400, error instanceof Error ? error.message : "持仓发布失败。", "PORTFOLIO_PUBLISH_FAILED"));
  }
});
