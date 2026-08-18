import type { Platform } from "../../shared/types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function validQrUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 8_192 && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : undefined;
}

export function qrUrlFromPayload(platform: Exclude<Platform, "bilibili">, payload: unknown) {
  const outer = record(payload);
  const data = record(outer?.data);
  const containers = [data, outer].filter((item): item is JsonRecord => Boolean(item));
  const keys = platform === "douyin"
    ? ["qrcode_index_url", "qrcode_url", "qr_url", "url"]
    : ["url", "qrcode_url", "qr_url"];
  for (const container of containers) {
    for (const key of keys) {
      const value = validQrUrl(container[key]);
      if (value) return value;
    }
  }
  return undefined;
}

export function pageLooksChallenged(input: {
  title?: string;
  url?: string;
  text?: string;
  hasChallengeElement?: boolean;
}) {
  if (input.hasChallengeElement) return true;
  return /验证码中间页|安全限制|安全验证|完成验证|访问频繁|操作频繁|滑块验证|请通过验证|captcha|verify|website-login\/(?:error|captcha)/i
    .test(`${input.title || ""}\n${input.url || ""}\n${input.text || ""}`);
}

export function hasChangedLoginCookie(
  cookies: Array<{ name: string; value: string }>,
  initial: Readonly<Record<string, string>>,
  acceptedNames: readonly string[]
) {
  return cookies.some((cookie) => acceptedNames.includes(cookie.name) && Boolean(cookie.value) && initial[cookie.name] !== cookie.value);
}
