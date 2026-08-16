import { Router, type Response } from "express";
import type { AuthSessionResponse } from "../../shared/types.js";
import { accessLevel, authenticate, clearSession } from "../auth.js";

export const authRouter = Router();

authRouter.post("/auth/login", (req, res: Response<AuthSessionResponse>) => {
  authenticate(req, res, "admin", req.body?.password);
  res.json({ authenticated: true });
});
authRouter.post("/auth/logout", (_req, res: Response<AuthSessionResponse>) => {
  clearSession(res);
  res.json({ authenticated: false });
});

authRouter.get("/auth/session", (req, res: Response<AuthSessionResponse>) => {
  res.set("Cache-Control", "private, no-store");
  res.vary("Cookie");
  res.json({ authenticated: accessLevel(req) === "admin" });
});
