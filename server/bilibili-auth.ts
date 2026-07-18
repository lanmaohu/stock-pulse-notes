import crypto from "node:crypto";
import QRCode from "qrcode";
import type { BilibiliQrSession, PlatformAccount } from "../shared/types.js";
import { assertCredentialEncryptionConfigured, encryptCredential } from "./credentials.js";
import { upsertPlatformAccount } from "./db.js";
import { checkBilibiliAccount } from "./platforms/bilibili.js";

interface QrState {
  id: string;
  qrcodeKey: string;
  qrImageDataUrl: string;
  status: BilibiliQrSession["status"];
  expiresAt: number;
  account?: PlatformAccount;
  error?: string;
}

interface PassportResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

const sessions = new Map<string, QrState>();
const passportHeaders = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bilibili.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
};

function publicSession(state: QrState): BilibiliQrSession {
  return {
    sessionId: state.id,
    qrImageDataUrl: state.status === "waiting" || state.status === "scanned" ? state.qrImageDataUrl : undefined,
    status: state.status,
    expiresAt: new Date(state.expiresAt).toISOString(),
    account: state.account,
    error: state.error
  };
}

function cleanSessions() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, state] of sessions) {
    if (state.expiresAt < cutoff) {
      sessions.delete(id);
    }
  }
}

export async function createBilibiliQrSession(): Promise<BilibiliQrSession> {
  assertCredentialEncryptionConfigured();
  cleanSessions();
  const response = await fetch("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", {
    headers: passportHeaders
  });
  if (!response.ok) {
    throw new Error(`生成 B 站二维码失败（${response.status}）。`);
  }
  const body = (await response.json()) as PassportResponse<{ url?: string; qrcode_key?: string }>;
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
    throw new Error(body.message || "生成 B 站二维码失败。");
  }
  const state: QrState = {
    id: crypto.randomUUID(),
    qrcodeKey: body.data.qrcode_key,
    qrImageDataUrl: await QRCode.toDataURL(body.data.url, { width: 260, margin: 1, errorCorrectionLevel: "M" }),
    status: "waiting",
    expiresAt: Date.now() + 180 * 1000
  };
  sessions.set(state.id, state);
  return publicSession(state);
}

function cookieParts(response: Response, loginUrl: string) {
  const values = new Map<string, string>();
  const cookieHeaders = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
  for (const header of cookieHeaders) {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  try {
    const params = new URL(loginUrl).searchParams;
    for (const name of ["DedeUserID", "DedeUserID__ckMd5", "SESSDATA", "bili_jct", "sid"]) {
      const value = params.get(name);
      if (value && !values.has(name)) {
        values.set(name, value);
      }
    }
  } catch {
    // Set-Cookie remains the primary source; malformed callback URLs are handled below.
  }
  return values;
}

async function appendDeviceCookies(values: Map<string, string>) {
  try {
    const response = await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: passportHeaders });
    const body = (await response.json()) as PassportResponse<{ b_3?: string; b_4?: string }>;
    if (body.code === 0) {
      if (body.data?.b_3) values.set("buvid3", body.data.b_3);
      if (body.data?.b_4) values.set("buvid4", body.data.b_4);
    }
  } catch {
    // Device cookies improve reliability but are not required to complete login.
  }
}

export async function pollBilibiliQrSession(sessionId: string): Promise<BilibiliQrSession> {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error("二维码会话不存在，请重新生成。");
  }
  if (state.status === "confirmed" || state.status === "error" || state.status === "expired") {
    return publicSession(state);
  }
  if (Date.now() >= state.expiresAt) {
    state.status = "expired";
    return publicSession(state);
  }

  const url = new URL("https://passport.bilibili.com/x/passport-login/web/qrcode/poll");
  url.searchParams.set("qrcode_key", state.qrcodeKey);
  try {
    const response = await fetch(url, { headers: passportHeaders, redirect: "manual" });
    if (!response.ok) {
      throw new Error(`确认 B 站扫码状态失败（${response.status}）。`);
    }
    const body = (await response.json()) as PassportResponse<{ code?: number; message?: string; url?: string }>;
    if (body.code !== 0 || !body.data) {
      throw new Error(body.message || "确认 B 站扫码状态失败。");
    }
    if (body.data.code === 86101) {
      state.status = "waiting";
      return publicSession(state);
    }
    if (body.data.code === 86090) {
      state.status = "scanned";
      return publicSession(state);
    }
    if (body.data.code === 86038) {
      state.status = "expired";
      return publicSession(state);
    }
    if (body.data.code !== 0 || !body.data.url) {
      throw new Error(body.data.message || "B 站扫码登录未完成。");
    }

    const values = cookieParts(response, body.data.url);
    await appendDeviceCookies(values);
    if (!values.get("SESSDATA") || !values.get("DedeUserID")) {
      throw new Error("B 站未返回完整登录凭证，请重新扫码。");
    }
    const credential = Array.from(values, ([name, value]) => `${name}=${value}`).join("; ");
    const identity = await checkBilibiliAccount(credential);
    state.account = upsertPlatformAccount({
      platform: "bilibili",
      externalUserId: identity.externalUserId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      encryptedCredential: encryptCredential(credential)
    });
    state.status = "confirmed";
    return publicSession(state);
  } catch (error) {
    state.status = "error";
    state.error = error instanceof Error ? error.message : "B 站扫码登录失败。";
    return publicSession(state);
  }
}
