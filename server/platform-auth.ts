import crypto from "node:crypto";
import type { Locator, Response as PlaywrightResponse } from "playwright-core";
import QRCode from "qrcode";
import type { Platform, PlatformQrSession } from "../shared/types.js";
import { cancelBilibiliQrSession, createBilibiliQrSession, pollBilibiliQrSession } from "./bilibili-auth.js";
import { assertCredentialEncryptionConfigured, encryptCredential } from "./credentials.js";
import { upsertPlatformAccount } from "./repositories/platform.js";
import { openPlatformBrowser, pageChallenge, serializeBrowserCredential, type ManagedBrowserSession } from "./platforms/browser.js";
import { platformAdapter } from "./platforms/index.js";
import { hasChangedLoginCookie, qrUrlFromPayload } from "./platforms/login-state.js";
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
  initialLoginCookies?: Record<string, string>;
  qrElementObserved?: boolean;
  loginObservedAt?: number;
  polling?: Promise<PlatformQrSession>;
  monitorTimer?: ReturnType<typeof setInterval>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, WebQrState>();

const specs = {
  douyin: {
    label: "抖音",
    url: "https://creator.douyin.com/",
    cookieNames: ["sessionid", "sessionid_ss", "sid_guard", "passport_auth_status", "LOGIN_STATUS"],
    qrResponsePath: "/passport/web/get_qrcode/",
    qrSelectors: [
      "#animate_qrcode_container img",
      "#douyin_login_landing_flat_container [class*='qrcode'] canvas",
      "#douyin_login_landing_flat_container [class*='qrcode'] img",
      "#douyin_login_landing_flat_container canvas",
      "#douyin_login_landing_flat_container img"
    ]
  },
  xiaohongshu: {
    label: "小红书",
    url: "https://www.xiaohongshu.com/login",
    cookieNames: ["web_session"],
    qrResponsePath: "/api/sns/web/v1/login/qrcode/create",
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
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.expiryTimer = undefined;
  state.monitorTimer = undefined;
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

async function loginCookieSnapshot(state: WebQrState) {
  const context = state.browser?.context;
  if (!context) return {};
  const accepted = specs[state.platform].cookieNames as readonly string[];
  return Object.fromEntries((await context.cookies())
    .filter((cookie) => accepted.includes(cookie.name))
    .map((cookie) => [cookie.name, cookie.value]));
}

async function waitForQr(state: WebQrState, capturedQrUrl: () => string | undefined, challengeSeen: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (challengeSeen() || await pageChallenge(state.browser!.page)) {
      throw new PlatformError("rate_limited", `${specs[state.platform].label}触发了安全验证，当前服务器网络无法生成登录二维码。`);
    }
    const locator = await visibleQr(state);
    if (locator) return { image: await screenshotQr(locator), elementObserved: true };
    const qrUrl = capturedQrUrl();
    if (qrUrl) {
      return {
        image: await QRCode.toDataURL(qrUrl, { width: 260, margin: 1, errorCorrectionLevel: "M" }),
        elementObserved: false
      };
    }
    await state.browser!.page.waitForTimeout(250);
  }
  if (state.platform === "douyin") {
    throw new PlatformError("rate_limited", "抖音未向当前服务器网络返回登录二维码；请稍后重试或配置可用的平台浏览器代理。");
  }
  throw new PlatformError("platform_error", "未能读取小红书登录二维码，平台页面结构可能已变化。");
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
    let qrUrl: string | undefined;
    let sawChallenge = false;
    const responseListener = (response: PlaywrightResponse) => {
      let pathname = "";
      try { pathname = new URL(response.url()).pathname; } catch { return; }
      if (/\/passport\/web\/challenge\/?$|\/website-login\/(?:error|captcha)/i.test(pathname)) sawChallenge = true;
      if (pathname !== specs[platform].qrResponsePath) return;
      void response.json()
        .then((payload) => { qrUrl = qrUrlFromPayload(platform, payload); })
        .catch(() => undefined);
    };
    page.on("response", responseListener);
    await page.goto(specs[platform].url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    if (!await visibleQr(state) && !qrUrl) {
      await page.getByText(platform === "douyin" ? "扫码登录" : "登录", { exact: true })
        .first().click({ timeout: 2_000, noWaitAfter: true }).catch(() => undefined);
    }
    const qr = await waitForQr(state, () => qrUrl, () => sawChallenge);
    page.off("response", responseListener);
    state.qrImageDataUrl = qr.image;
    state.qrElementObserved = qr.elementObserved;
    state.initialLoginCookies = await loginCookieSnapshot(state);
    sessions.set(state.id, state);
    state.monitorTimer = setInterval(() => {
      if (state.status !== "waiting" && state.status !== "scanned") {
        if (state.monitorTimer) clearInterval(state.monitorTimer);
        state.monitorTimer = undefined;
        return;
      }
      if (state.polling) return;
      state.polling = pollWebState(state).finally(() => { state.polling = undefined; });
    }, 1_000);
    state.monitorTimer.unref?.();
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
  const cookies = await context.cookies();
  return hasChangedLoginCookie(cookies, state.initialLoginCookies || {}, specs[state.platform].cookieNames);
}

function isNavigationRace(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context with specified id|frame was detached|most likely because of a navigation/i.test(message);
}

async function pollWebState(state: WebQrState, signal?: AbortSignal): Promise<PlatformQrSession> {
  if (state.status === "confirmed" || state.status === "expired" || state.status === "error") return publicSession(state);
  if (Date.now() >= state.expiresAt) {
    state.status = "expired";
    await closeState(state);
    return publicSession(state);
  }
  const browser = state.browser;
  if (!browser || browser.page.isClosed() || !browser.browser.isConnected()) {
    state.status = "error";
    state.error = "登录浏览器已关闭，请重新生成二维码。";
    await closeState(state);
    return publicSession(state);
  }
  try {
    if (await pageChallenge(browser.page)) throw new PlatformError("rate_limited", `${specs[state.platform].label}触发了安全验证，请稍后重新绑定。`);
    if (!await hasLoginCookie(state)) {
      state.status = state.qrElementObserved && !await visibleQr(state) ? "scanned" : "waiting";
      return publicSession(state);
    }
    // Xiaohongshu updates web_session before its post-login redirect and the
    // remaining account cookies have settled. Keep polling non-blocking while
    // giving that redirect the same grace period used by maintained clients.
    state.loginObservedAt ||= Date.now();
    if (state.platform === "xiaohongshu" && Date.now() - state.loginObservedAt < 5_000) {
      state.status = "scanned";
      return publicSession(state);
    }
    const credential = await serializeBrowserCredential(state.platform, browser.context, browser.userAgent);
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
    // A successful scan redirects the login page. If a platform operation
    // overlaps that redirect, keep the QR session alive and retry on the next
    // poll instead of exposing an internal Playwright error to the admin UI.
    if (isNavigationRace(error) && state.browser && !state.browser.page.isClosed()) {
      state.status = "scanned";
      state.error = undefined;
      return publicSession(state);
    }
    state.status = "error";
    state.error = error instanceof PlatformError
      ? error.message
      : `${specs[state.platform].label}扫码登录失败，请重新生成二维码后再试。`;
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
