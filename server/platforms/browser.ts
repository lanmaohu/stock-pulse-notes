import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { chromium } from "playwright-core";
import type { Platform } from "../../shared/types.js";
import { platformBrowserExecutablePath } from "../config.js";
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
  close(): Promise<void>;
}

const activeSessions = new Set<ManagedBrowserSession>();
let browserBusy = false;

function webPlatform(platform: Platform): asserts platform is "douyin" | "xiaohongshu" {
  if (platform === "bilibili") throw new PlatformError("platform_error", "B 站不使用浏览器会话。");
}

export function parseBrowserCredential(platform: Platform, credential: string): BrowserCredentialEnvelope {
  webPlatform(platform);
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new PlatformError("auth_required", "平台登录凭证已损坏，请重新扫码绑定。");
  }
  const candidate = parsed as Partial<BrowserCredentialEnvelope> | null;
  if (
    !candidate || candidate.version !== 1 || candidate.platform !== platform ||
    typeof candidate.userAgent !== "string" || !candidate.userAgent ||
    !candidate.storageState || !Array.isArray(candidate.storageState.cookies) || !Array.isArray(candidate.storageState.origins)
  ) {
    throw new PlatformError("auth_required", "平台登录凭证格式无效，请重新扫码绑定。");
  }
  return candidate as BrowserCredentialEnvelope;
}

export async function serializeBrowserCredential(
  platform: "douyin" | "xiaohongshu",
  context: BrowserContext,
  page: Page
) {
  return JSON.stringify({
    version: 1,
    platform,
    userAgent: await page.evaluate(() => navigator.userAgent),
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
    browser = await chromium.launch({
      executablePath: platformBrowserExecutablePath(),
      headless: true,
      timeout: 6_000,
      args: ["--disable-dev-shm-usage"]
    });
    const options: BrowserContextOptions = {
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 960 },
      userAgent: envelope?.userAgent,
      storageState: envelope?.storageState
    };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(13_000);
    let closed = false;
    const session: ManagedBrowserSession = {
      browser,
      context,
      page,
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
  const text = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 4_000);
  return /安全验证|完成验证|访问频繁|操作频繁|滑块验证|captcha|verify/i.test(text);
}
