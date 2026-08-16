import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertCredentialEncryptionConfigured } from "./credentials.js";

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

function validateSharedSecrets() {
  requiredSecret("SESSION_SECRET");
  requiredSecret("PORTFOLIO_VIEW_PASSWORD");
  requiredSecret("PORTFOLIO_ADMIN_PASSWORD");
  requiredSecret("PLATFORM_CREDENTIALS_KEY");
  assertCredentialEncryptionConfigured();
  databasePath();
}

export function validateApiEnvironment() {
  apiPort();
  validateSharedSecrets();
  requiredSecret("WEBHOOK_TOKEN");
}

export function validateWorkerEnvironment() {
  validateSharedSecrets();
  requiredSecret("DEEPSEEK_API_KEY");
}
