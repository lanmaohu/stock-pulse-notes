import type { Page, Response } from "playwright-core";
import { PlatformError } from "./types.js";
import { pageChallenge } from "./browser.js";

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

export function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function numberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function imageValue(value: unknown): string | undefined {
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  const object = record(value);
  if (!object) return undefined;
  const direct = stringValue(object.url, object.url_default, object.urlDefault);
  if (direct) return direct;
  for (const key of ["url_list", "urlList", "info_list", "infoList"]) {
    const list = object[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const found = imageValue(item);
      if (found) return found;
    }
  }
  return undefined;
}

export function recordsDeep(value: unknown, maximum = 20_000) {
  const output: JsonRecord[] = [];
  const queue: unknown[] = [value];
  while (queue.length && output.length < maximum) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const object = record(current);
    if (!object) continue;
    output.push(object);
    queue.push(...Object.values(object));
  }
  return output;
}

async function responseJson(response: Response) {
  const contentType = response.headers()["content-type"] || "";
  if (!contentType.includes("json") && !/\/api\//.test(response.url())) return undefined;
  return response.json().catch(() => undefined);
}

export async function capturePageJson(
  page: Page,
  action: () => Promise<unknown>,
  matches: (url: string) => boolean,
  settleMs = 1_800
) {
  const pending = new Set<Promise<void>>();
  const payloads: unknown[] = [];
  const listener = (response: Response) => {
    if (!matches(response.url())) return;
    const task = responseJson(response).then((payload) => {
      if (payload !== undefined) payloads.push(payload);
    }).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on("response", listener);
  try {
    await action();
    await page.waitForTimeout(settleMs);
    await Promise.all(pending);
    return payloads;
  } finally {
    page.off("response", listener);
  }
}

export async function assertUsablePage(page: Page, platformLabel: string) {
  if (/login|passport/i.test(page.url())) {
    throw new PlatformError("auth_required", `${platformLabel}登录状态已失效，请重新扫码绑定。`);
  }
  if (await pageChallenge(page)) {
    throw new PlatformError("rate_limited", `${platformLabel}触发了安全验证，请稍后重试或重新扫码绑定。`);
  }
}

export function isoDate(value: unknown) {
  const parsed = numberValue(value);
  if (parsed !== undefined) {
    const milliseconds = parsed > 10_000_000_000 ? parsed : parsed * 1_000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

export function metadataText(title: string, description: string, tags: string[]) {
  return [title ? `标题：${title}` : "", description ? `简介：${description}` : "", tags.length ? `标签：${tags.join("、")}` : ""]
    .filter(Boolean)
    .join("\n");
}
