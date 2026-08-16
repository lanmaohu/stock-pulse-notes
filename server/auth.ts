import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PortfolioAccessLevel } from "../shared/types.js";
import { requiredSecret } from "./config.js";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "./repositories/auth.js";
import { HttpError } from "./http-error.js";

export const sessionCookie = "stockpulse_portfolio_session";
const viewerMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const adminMaxAgeMs = 8 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function rolePassword(role: "viewer" | "admin") {
  return requiredSecret(role === "admin" ? "PORTFOLIO_ADMIN_PASSWORD" : "PORTFOLIO_VIEW_PASSWORD");
}

function sign(payload: string) {
  return crypto.createHmac("sha256", requiredSecret("SESSION_SECRET")).update(payload).digest("base64url");
}

function credentialVersion(role: "viewer" | "admin") {
  return crypto
    .createHmac("sha256", requiredSecret("SESSION_SECRET"))
    .update(`credential:${role}:${rolePassword(role)}`)
    .digest("base64url")
    .slice(0, 22);
}

function createToken(role: "viewer" | "admin") {
  const maxAge = role === "admin" ? adminMaxAgeMs : viewerMaxAgeMs;
  const payload = Buffer.from(JSON.stringify({
    aud: "stockpulse",
    role,
    ver: credentialVersion(role),
    exp: Date.now() + maxAge
  })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, maxAge };
}

function cookieValue(req: Request, name: string) {
  for (const entry of (req.header("cookie") || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function accessLevel(req: Request): PortfolioAccessLevel {
  const [payload, signature, extra] = cookieValue(req, sessionCookie).split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return "public";
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      aud?: unknown;
      role?: unknown;
      ver?: unknown;
      exp?: unknown;
    };
    if (parsed.aud !== "stockpulse" || (parsed.role !== "viewer" && parsed.role !== "admin")) return "public";
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return "public";
    if (parsed.ver !== credentialVersion(parsed.role)) return "public";
    return parsed.role;
  } catch {
    return "public";
  }
}

function loginAddress(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function authenticate(req: Request, res: Response, role: "viewer" | "admin", password: unknown) {
  const address = loginAddress(req);
  if (!assertLoginAllowed("portfolio", address)) {
    throw new HttpError(429, "尝试次数过多，请稍后再试。", "LOGIN_RATE_LIMITED");
  }
  if (typeof password !== "string" || !safeEqual(password, rolePassword(role))) {
    recordLoginFailure("portfolio", address, Date.now() + loginWindowMs);
    throw new HttpError(401, "密码不正确。", "INVALID_CREDENTIALS");
  }
  clearLoginFailures("portfolio", address);
  const secure = req.secure || req.header("x-forwarded-proto") === "https";
  const { token, maxAge } = createToken(role);
  res.cookie(sessionCookie, token, { httpOnly: true, secure, sameSite: "strict", maxAge, path: "/" });
}

export function clearSession(res: Response) {
  res.clearCookie(sessionCookie, { path: "/" });
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const level = accessLevel(req);
  if (level === "admin") return next();
  throw new HttpError(level === "public" ? 401 : 403, "需要管理员权限。", level === "public" ? "AUTH_REQUIRED" : "FORBIDDEN");
}

export function requireWebhook(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!safeEqual(token, requiredSecret("WEBHOOK_TOKEN"))) {
    throw new HttpError(401, "Unauthorized webhook.", "INVALID_WEBHOOK_TOKEN");
  }
  next();
}
