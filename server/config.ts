import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertCredentialEncryptionConfigured } from "./credentials.js";

export const deepSeekModel = "deepseek-v4-pro" as const;

export interface AiConfig {
  provider: "deepseek";
  model: typeof deepSeekModel;
  endpoint: "https://api.deepseek.com/chat/completions";
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface BackupConfig {
  directory: string;
  localTime: string;
  retentionDays: number;
  minimumCount: number;
}

export interface TwitterOAuthConfig {
  clientId: string;
  clientSecret?: string;
  callbackUrl: string;
}

let loaded = false;

export function loadEnvironment() {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvironment();

export function requiredSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("change-this") || value.includes("replace-with")) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

export function apiPort() {
  const value = process.env.PORT?.trim() || "3000";
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer between 1 and 65535.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function databasePath() {
  const configured = process.env.STOCKPULSE_DB_PATH?.trim();
  if (process.env.STOCKPULSE_DB_PATH !== undefined && !configured) {
    throw new Error("STOCKPULSE_DB_PATH cannot be empty.");
  }
  return path.resolve(configured || path.join(process.cwd(), "data", "stockpulse.sqlite"));
}

export function platformBrowserExecutablePath() {
  const configured = process.env.PLATFORM_BROWSER_EXECUTABLE_PATH?.trim();
  const candidates = [
    configured,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!executable) {
    throw new Error("PLATFORM_BROWSER_EXECUTABLE_PATH 未指向可用的 Chromium。请先安装 Chromium 并配置该路径。");
  }
  return path.resolve(executable);
}

export function platformBrowserHeadless() {
  const configured = process.env.PLATFORM_BROWSER_HEADLESS?.trim().toLowerCase();
  if (!configured) return true;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error("PLATFORM_BROWSER_HEADLESS must be true or false.");
}

export function platformBrowserDisplay() {
  return process.env.PLATFORM_BROWSER_DISPLAY?.trim() || process.env.DISPLAY?.trim() || ":99";
}

export function platformBrowserProxy() {
  const server = process.env.PLATFORM_BROWSER_PROXY_SERVER?.trim();
  const username = process.env.PLATFORM_BROWSER_PROXY_USERNAME?.trim();
  const password = process.env.PLATFORM_BROWSER_PROXY_PASSWORD?.trim();
  if (!server) {
    if (username || password) throw new Error("PLATFORM_BROWSER_PROXY_SERVER is required when proxy credentials are configured.");
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error("PLATFORM_BROWSER_PROXY_SERVER must be a valid HTTP, HTTPS, or SOCKS5 URL.");
  }
  if (!/^https?:$|^socks5:$/.test(parsed.protocol) || !parsed.hostname || !parsed.port || parsed.username || parsed.password) {
    throw new Error("PLATFORM_BROWSER_PROXY_SERVER must be an HTTP, HTTPS, or SOCKS5 URL without embedded credentials.");
  }
  if (password && !username) throw new Error("PLATFORM_BROWSER_PROXY_USERNAME is required when a proxy password is configured.");
  return { server, username, password };
}

export function twitterOAuthConfig(): TwitterOAuthConfig {
  const clientId = process.env.TWITTER_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITTER_CLIENT_SECRET?.trim() || undefined;
  const callbackUrl = process.env.TWITTER_OAUTH_CALLBACK_URL?.trim();
  if (!clientId || !callbackUrl) {
    throw new Error("TWITTER_CLIENT_ID 和 TWITTER_OAUTH_CALLBACK_URL 尚未配置。");
  }
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error("TWITTER_OAUTH_CALLBACK_URL 必须是有效的 HTTPS URL。");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if ((!local && parsed.protocol !== "https:") || (local && !/^https?:$/.test(parsed.protocol))) {
    throw new Error("TWITTER_OAUTH_CALLBACK_URL 必须使用 HTTPS（本地 localhost 可使用 HTTP）。");
  }
  return { clientId, clientSecret, callbackUrl: parsed.toString() };
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function backupConfig(): BackupConfig {
  const localTime = process.env.BACKUP_LOCAL_TIME?.trim() || "03:15";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw new Error("BACKUP_LOCAL_TIME must use 24-hour HH:MM format.");
  }
  return {
    directory: path.resolve(process.env.STOCKPULSE_BACKUP_DIR?.trim() || path.join(process.cwd(), "backups")),
    localTime,
    retentionDays: integerEnvironment("BACKUP_RETENTION_DAYS", 30, 1, 3650),
    minimumCount: integerEnvironment("BACKUP_MINIMUM_COUNT", 7, 1, 1000)
  };
}

export function releaseId() {
  return process.env.STOCKPULSE_RELEASE?.trim().slice(0, 100) || "development";
}

export function aiConfig(): AiConfig {
  const configuredModel = process.env.AI_MODEL?.trim() || deepSeekModel;
  if (configuredModel !== deepSeekModel) {
    const legacyHint = configuredModel === "deepseek-chat" || configuredModel === "deepseek-reasoner"
      ? " Legacy DeepSeek model aliases are no longer supported."
      : "";
    throw new Error(`AI_MODEL must be ${deepSeekModel}.${legacyHint}`);
  }
  return {
    provider: "deepseek",
    model: deepSeekModel,
    endpoint: "https://api.deepseek.com/chat/completions",
    timeoutMs: 90_000,
    maxOutputTokens: 6_000
  };
}

function validateSharedSecrets() {
  requiredSecret("SESSION_SECRET");
  requiredSecret("PORTFOLIO_VIEW_PASSWORD");
  requiredSecret("PORTFOLIO_ADMIN_PASSWORD");
  requiredSecret("PLATFORM_CREDENTIALS_KEY");
  assertCredentialEncryptionConfigured();
  databasePath();
  backupConfig();
}

export function validateApiEnvironment() {
  apiPort();
  platformBrowserHeadless();
  platformBrowserProxy();
  validateSharedSecrets();
  requiredSecret("WEBHOOK_TOKEN");
}

export function validateWorkerEnvironment() {
  platformBrowserHeadless();
  platformBrowserProxy();
  validateSharedSecrets();
  requiredSecret("DEEPSEEK_API_KEY");
  aiConfig();
}
