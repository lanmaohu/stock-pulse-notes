import type { Request } from "express";
import type { Platform } from "../shared/types.js";
import { HttpError } from "./http-error.js";

export function routeParam(req: Request, name: string) {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}
export function assertDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(`${value}T00:00:00.000Z`) : null;
  if (!match || !parsed || Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3])) {
    throw new HttpError(400, "Date must be YYYY-MM-DD.", "INVALID_DATE");
  }
}

export function positiveIntegerQuery(value: unknown, name: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new HttpError(400, `${name} must be a positive integer.`, "INVALID_QUERY");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, `${name} must be a positive integer.`, "INVALID_QUERY");
  return parsed;
}

export function platformValue(value: unknown): Platform {
  if (value === "bilibili" || value === "douyin" || value === "xiaohongshu") return value;
  throw new HttpError(400, "不支持的平台。", "UNSUPPORTED_PLATFORM");
}
