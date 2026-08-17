import { existsSync, readFileSync } from "node:fs";
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
  validateSharedSecrets();
  requiredSecret("WEBHOOK_TOKEN");
}

export function validateWorkerEnvironment() {
  validateSharedSecrets();
  requiredSecret("DEEPSEEK_API_KEY");
  aiConfig();
}
