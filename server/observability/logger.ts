import { releaseId } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const platformSecretNames = [
  "web_session",
  "sessionid",
  "sessionid_ss",
  "sid_guard",
  "passport_auth_status",
  "SESSDATA",
  "bili_jct",
  "access_token",
  "refresh_token",
  "xsec_token"
] as const;

export function redactSensitiveText(value: string) {
  const names = platformSecretNames.join("|");
  return value
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(new RegExp(`("name"\\s*:\\s*"(?:${names})"\\s*,\\s*"value"\\s*:\\s*")[^"]*"`, "gi"), "$1[REDACTED]\"")
    .replace(new RegExp(`((?:["']?(?:${names})["']?)\\s*[:=]\\s*["']?)[^"'\\s,;}]+`, "gi"), "$1[REDACTED]");
}

function sensitiveFieldName(name: string) {
  return /^(?:authorization|proxyAuthorization|cookie|cookies|setCookie|storageState|credentialsCiphertext|qrImageDataUrl|accessToken|refreshToken|xsecToken|password|secret)$/i.test(name);
}

function redactLogValue(value: unknown, fieldName = "", depth = 0): unknown {
  if (sensitiveFieldName(fieldName)) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (depth >= 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, "", depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLogValue(item, key, depth + 1)]));
}

export function sanitizeLogFields(fields: Record<string, unknown>) {
  return redactLogValue(fields) as Record<string, unknown>;
}

function serviceName() {
  return process.env.STOCKPULSE_SERVICE?.trim().slice(0, 40) || "stockpulse";
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const entry = {
    ...sanitizeLogFields(fields),
    timestamp: new Date().toISOString(),
    level,
    service: serviceName(),
    release: releaseId(),
    event
  };
  const output = `${JSON.stringify(entry)}\n`;
  if (level === "error" || level === "fatal") process.stderr.write(output);
  else process.stdout.write(output);
}

export function errorFields(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "Error",
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  };
}
