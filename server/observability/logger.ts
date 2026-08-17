import { releaseId } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

function serviceName() {
  return process.env.STOCKPULSE_SERVICE?.trim().slice(0, 40) || "stockpulse";
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const entry = {
    ...fields,
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
    message: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
  };
}
