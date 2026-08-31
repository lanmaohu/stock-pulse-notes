import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { chromium } from "playwright-core";
import type { Platform } from "../../shared/types.js";
import {
  platformBrowserDisplay,
  platformBrowserExecutablePath,
  platformBrowserHeadless,
  platformBrowserProxy
} from "../config.js";
import { pageLooksChallenged } from "./login-state.js";
import { PlatformError } from "./types.js";

interface BrowserStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface BrowserCredentialEnvelope {
  version: 1;
  platform: "douyin" | "xiaohongshu";
  userAgent: string;
  storageState: BrowserStorageState;
}

export interface ManagedBrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  userAgent: string;
  close(): Promise<void>;
}

const activeSessions = new Set<ManagedBrowserSession>();
let browserBusy = false;
const maxCredentialBytes = 2 * 1024 * 1024;

function webPlatform(platform: Platform): asserts platform is "douyin" | "xiaohongshu" {
  if (platform === "bilibili" || platform === "twitter") {
    throw new PlatformError("platform_error", `${platform === "twitter" ? "Twitter/X" : "B 站"}不使用浏览器会话。`);
  }
}

function validStoredCookie(value: unknown): value is BrowserStorageState["cookies"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cookie = value as Partial<BrowserStorageState["cookies"][number]>;
  return typeof cookie.name === "string" && cookie.name.length > 0 && cookie.name.length <= 256 &&
    typeof cookie.value === "string" && cookie.value.length <= 16_384 &&
    typeof cookie.domain === "string" && cookie.domain.length > 0 && cookie.domain.length <= 512 &&
    typeof cookie.path === "string" && cookie.path.startsWith("/") && cookie.path.length <= 2_048 &&
    typeof cookie.expires === "number" && Number.isFinite(cookie.expires) &&
    typeof cookie.httpOnly === "boolean" && typeof cookie.secure === "boolean" &&
    (cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None");
}

function validStoredOrigin(value: unknown): value is BrowserStorageState["origins"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Partial<BrowserStorageState["origins"][number]>;
  if (typeof origin.origin !== "string" || origin.origin.length > 2_048 || !/^https?:\/\//i.test(origin.origin)) return false;
  if (!Array.isArray(origin.localStorage) || origin.localStorage.length > 500) return false;
  return origin.localStorage.every((entry) => Boolean(entry) && typeof entry === "object" &&
    typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 1_024 &&
    typeof entry.value === "string" && entry.value.length <= 256_000);
}

export function parseBrowserCredential(platform: Platform, credential: string): BrowserCredentialEnvelope {
  webPlatform(platform);
  if (Buffer.byteLength(credential, "utf8") > maxCredentialBytes) {
    throw new PlatformError("auth_required", "平台登录凭证格式无效，请重新扫码绑定。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new PlatformError("auth_required", "平台登录凭证已损坏，请重新扫码绑定。");
  }
  const candidate = parsed as Partial<BrowserCredentialEnvelope> | null;
  if (
    !candidate || candidate.version !== 1 || candidate.platform !== platform ||
    typeof candidate.userAgent !== "string" || !candidate.userAgent || candidate.userAgent.length > 1_024 ||
    !candidate.storageState || !Array.isArray(candidate.storageState.cookies) || candidate.storageState.cookies.length > 500 ||
    !Array.isArray(candidate.storageState.origins) || candidate.storageState.origins.length > 50 ||
    !candidate.storageState.cookies.every(validStoredCookie) ||
    !candidate.storageState.origins.every(validStoredOrigin)
  ) {
    throw new PlatformError("auth_required", "平台登录凭证格式无效，请重新扫码绑定。");
  }
  return candidate as BrowserCredentialEnvelope;
}

export async function serializeBrowserCredential(
  platform: "douyin" | "xiaohongshu",
  context: BrowserContext,
  userAgent: string
) {
  return JSON.stringify({
    version: 1,
    platform,
    userAgent,
    storageState: await context.storageState()
  } satisfies BrowserCredentialEnvelope);
}

function browserError(error: unknown) {
  if (error instanceof PlatformError) return error;
  const message = error instanceof Error ? error.message : "Chromium 启动失败。";
  if (/executable|browser.*not found|failed to launch|ENOENT/i.test(message)) {
    return new PlatformError("browser_unavailable", "服务器上的 Chromium 不可用，请检查浏览器安装与配置。");
  }
  return new PlatformError("platform_error", message.includes("Timeout") ? "平台页面加载超时，请稍后重试。" : "平台浏览器操作失败，请稍后重试。");
}

export async function openPlatformBrowser(
  platform: Platform,
  credential?: string,
  signal?: AbortSignal
): Promise<ManagedBrowserSession> {
  webPlatform(platform);
  if (signal?.aborted) throw signal.reason;
  if (browserBusy) throw new PlatformError("browser_unavailable", "平台浏览器正在处理其他操作，请稍后再试。");
  browserBusy = true;
  let browser: Browser | undefined;
  try {
    const envelope = credential ? parseBrowserCredential(platform, credential) : undefined;
    const headless = platformBrowserHeadless();
    browser = await chromium.launch({
      executablePath: platformBrowserExecutablePath(),
      headless,
      timeout: 6_000,
      proxy: platformBrowserProxy(),
      env: headless ? process.env : { ...process.env, DISPLAY: platformBrowserDisplay() },
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });
    const options: BrowserContextOptions = {
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 960 },
      screen: { width: 1440, height: 960 },
      colorScheme: "light",
      userAgent: envelope?.userAgent,
      storageState: envelope?.storageState
    };
    const context = await browser.newContext(options);
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { configurable: true, get: () => undefined });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(13_000);
    // Capture this while the page is still on about:blank. Reading it during a
    // successful QR login races with the platform's automatic navigation.
    const userAgent = envelope?.userAgent || await page.evaluate(() => navigator.userAgent);
    let closed = false;
    const session: ManagedBrowserSession = {
      browser,
      context,
      page,
      userAgent,
      async close() {
        if (closed) return;
        closed = true;
        activeSessions.delete(session);
        try {
          await browser?.close();
        } finally {
          browserBusy = false;
        }
      }
    };
    activeSessions.add(session);
    if (signal) {
      signal.addEventListener("abort", () => { void session.close(); }, { once: true });
    }
    return session;
  } catch (error) {
    browserBusy = false;
    await browser?.close().catch(() => undefined);
    throw browserError(error);
  }
}

export async function withPlatformBrowser<T>(
  platform: Platform,
  credential: string,
  operation: (session: ManagedBrowserSession) => Promise<T>,
  signal?: AbortSignal,
  operationTimeoutMs = 20_000
) {
  const session = await openPlatformBrowser(platform, credential, signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const operationTimeout = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void session.close();
        reject(new PlatformError("platform_error", "平台浏览器操作超时，请稍后重试。"));
      }, operationTimeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([operation(session), operationTimeout]);
  } catch (error) {
    throw browserError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    await session.close();
  }
}

export async function closePlatformBrowsers() {
  await Promise.all(Array.from(activeSessions, (session) => session.close().catch(() => undefined)));
}

export async function pageChallenge(page: Page) {
  const [title, text, hasChallengeElement] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
    page.locator("iframe[src*='verify'], iframe[src*='captcha'], [id*='captcha'], [class*='captcha']")
      .first().isVisible().catch(() => false)
  ]);
  return pageLooksChallenged({ title, url: page.url(), text: text.slice(0, 4_000), hasChallengeElement });
}
