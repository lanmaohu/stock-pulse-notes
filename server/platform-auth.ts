import crypto from "node:crypto";
import type { Locator } from "playwright-core";
import type { Platform, PlatformQrSession } from "../shared/types.js";
import { cancelBilibiliQrSession, createBilibiliQrSession, pollBilibiliQrSession } from "./bilibili-auth.js";
import { assertCredentialEncryptionConfigured, encryptCredential } from "./credentials.js";
import { upsertPlatformAccount } from "./repositories/platform.js";
import { openPlatformBrowser, pageChallenge, serializeBrowserCredential, type ManagedBrowserSession } from "./platforms/browser.js";
import { platformAdapter } from "./platforms/index.js";
import { PlatformError } from "./platforms/types.js";

type WebPlatform = Exclude<Platform, "bilibili">;

interface WebQrState {
  id: string;
  platform: WebPlatform;
  status: PlatformQrSession["status"];
  expiresAt: number;
  qrImageDataUrl?: string;
  account?: PlatformQrSession["account"];
  error?: string;
  browser?: ManagedBrowserSession;
  polling?: Promise<PlatformQrSession>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, WebQrState>();

const specs = {
  douyin: {
    label: "抖音",
    url: "https://www.douyin.com/",
    cookieNames: ["sessionid", "sessionid_ss", "sid_guard", "passport_auth_status"],
    qrSelectors: ["[class*='qrcode'] canvas", "[class*='qrcode'] img", "[class*='login'] canvas", "[class*='login'] img[src*='data:image']"]
  },
  xiaohongshu: {
    label: "小红书",
    url: "https://www.xiaohongshu.com/explore",
    cookieNames: ["web_session"],
    qrSelectors: [".qrcode-img", ".login-container [class*='qrcode'] img", ".login-container canvas", "[class*='qrcode'] img"]
  }
} as const;

function publicSession(state: WebQrState): PlatformQrSession {
  return {
    platform: state.platform,
    sessionId: state.id,
    qrImageDataUrl: state.status === "waiting" || state.status === "scanned" ? state.qrImageDataUrl : undefined,
    status: state.status,
    expiresAt: new Date(state.expiresAt).toISOString(),
    account: state.account,
    error: state.error
  };
}

async function closeState(state: WebQrState) {
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  state.expiryTimer = undefined;
  const browser = state.browser;
  state.browser = undefined;
  await browser?.close().catch(() => undefined);
}

function cleanSessions() {
  const cutoff = Date.now() - 10 * 60 * 1_000;
  for (const [id, state] of sessions) {
    if (state.expiresAt >= cutoff) continue;
    sessions.delete(id);
    void closeState(state);
  }
}

async function visibleQr(state: WebQrState) {
  const page = state.browser?.page;
  if (!page) return undefined;
  for (const selector of specs[state.platform].qrSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}

async function screenshotQr(locator: Locator) {
  const image = await locator.screenshot({ type: "png", timeout: 3_000 });
  return `data:image/png;base64,${image.toString("base64")}`;
}

async function createWebQrSession(platform: WebPlatform, signal?: AbortSignal): Promise<PlatformQrSession> {
  assertCredentialEncryptionConfigured();
  cleanSessions();
  const browser = await openPlatformBrowser(platform, undefined, signal);
  const state: WebQrState = {
    id: crypto.randomUUID(), platform, status: "waiting", expiresAt: Date.now() + 180 * 1_000, browser
  };
  try {
    const { page } = browser;
    await page.goto(specs[platform].url, { waitUntil: "domcontentloaded" });
    await page.getByText("登录", { exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    if (await pageChallenge(page)) throw new PlatformError("rate_limited", `${specs[platform].label}触发了安全验证，请稍后重试。`);
    const qr = await visibleQr(state);
    if (!qr) throw new PlatformError("platform_error", `未能读取${specs[platform].label}登录二维码，平台页面结构可能已变化。`);
    state.qrImageDataUrl = await screenshotQr(qr);
    sessions.set(state.id, state);
    state.expiryTimer = setTimeout(() => {
      if (state.status !== "waiting" && state.status !== "scanned") return;
      state.status = "expired";
      state.qrImageDataUrl = undefined;
      void closeState(state);
    }, Math.max(0, state.expiresAt - Date.now()));
    state.expiryTimer.unref?.();
    return publicSession(state);
  } catch (error) {
    await closeState(state);
    throw error;
  }
}

async function hasLoginCookie(state: WebQrState) {
  const context = state.browser?.context;
  if (!context) return false;
  const cookies = await context.cookies(specs[state.platform].url);
  return cookies.some((cookie) => specs[state.platform].cookieNames.some((name) => name === cookie.name) && Boolean(cookie.value));
}

async function pollWebState(state: WebQrState, signal?: AbortSignal): Promise<PlatformQrSession> {
  if (state.status === "confirmed" || state.status === "expired" || state.status === "error") return publicSession(state);
  if (Date.now() >= state.expiresAt) {
    state.status = "expired";
    await closeState(state);
    return publicSession(state);
  }
  const browser = state.browser;
  if (!browser || browser.page.isClosed()) {
    state.status = "error";
    state.error = "登录浏览器已关闭，请重新生成二维码。";
    return publicSession(state);
  }
  try {
    if (await pageChallenge(browser.page)) throw new PlatformError("rate_limited", `${specs[state.platform].label}触发了安全验证，请稍后重新绑定。`);
    if (!await hasLoginCookie(state)) {
      state.status = await visibleQr(state) ? "waiting" : "scanned";
      return publicSession(state);
    }
    const credential = await serializeBrowserCredential(state.platform, browser.context, browser.page);
    await closeState(state);
    const identity = await platformAdapter(state.platform).checkAccount(credential, signal);
    state.account = upsertPlatformAccount({
      platform: state.platform,
      externalUserId: identity.externalUserId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      encryptedCredential: encryptCredential(credential)
    });
    state.status = "confirmed";
    state.qrImageDataUrl = undefined;
    return publicSession(state);
  } catch (error) {
    state.status = "error";
    state.error = error instanceof Error ? error.message : `${specs[state.platform].label}扫码登录失败。`;
    await closeState(state);
    return publicSession(state);
  }
}

export async function createPlatformQrSession(platform: Platform, signal?: AbortSignal) {
  if (platform === "bilibili") return createBilibiliQrSession(signal);
  return createWebQrSession(platform, signal);
}

export async function pollPlatformQrSession(platform: Platform, sessionId: string, signal?: AbortSignal) {
  if (platform === "bilibili") return pollBilibiliQrSession(sessionId, signal);
  const state = sessions.get(sessionId);
  if (!state || state.platform !== platform) throw new Error("二维码会话不存在，请重新生成。");
  if (!state.polling) state.polling = pollWebState(state, signal).finally(() => { state.polling = undefined; });
  return state.polling;
}

export async function cancelPlatformQrSession(platform: Platform, sessionId: string) {
  if (platform === "bilibili") return cancelBilibiliQrSession(sessionId);
  const state = sessions.get(sessionId);
  if (!state || state.platform !== platform) return false;
  sessions.delete(sessionId);
  await closeState(state);
  return true;
}

export async function closePlatformQrSessions() {
  await Promise.all(Array.from(sessions.values(), (state) => closeState(state)));
  sessions.clear();
}
