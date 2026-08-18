import fs from "node:fs";
import { backupConfig, databasePath, platformBrowserExecutablePath, releaseId, validateApiEnvironment, validateWorkerEnvironment } from "../config.js";
import { readinessStatus } from "../database/health.js";

export interface DoctorReport {
  ok: boolean;
  release: string;
  node: { status: "ok" | "error"; version: string; required: string };
  configuration: { status: "ok" | "error"; message?: string };
  browser: { status: "ok" | "error"; executable?: string; message?: string };
  readiness: Awaited<ReturnType<typeof readinessStatus>>;
  disk: { status: "ok" | "warn" | "error"; availableBytes?: number; databaseBytes?: number };
  warnings: string[];
}

function nodeSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major === 22 && (minor || 0) >= 16;
}

export async function doctorReport(now = Date.now()): Promise<DoctorReport> {
  let configuration: DoctorReport["configuration"] = { status: "ok" };
  try {
    validateApiEnvironment();
    validateWorkerEnvironment();
  } catch (error) {
    configuration = { status: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const readiness = await readinessStatus(now);
  let browser: DoctorReport["browser"];
  try {
    browser = { status: "ok", executable: platformBrowserExecutablePath() };
  } catch (error) {
    browser = { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const warnings: string[] = [];
  if (readiness.queue.oldestQueuedAt && now - Date.parse(readiness.queue.oldestQueuedAt) > 15 * 60 * 1_000) {
    warnings.push("The oldest collection run has been queued for more than 15 minutes.");
  }
  if (readiness.queue.expiredLeases > 0) warnings.push(`${readiness.queue.expiredLeases} collection run leases have expired.`);

  let disk: DoctorReport["disk"] = { status: "error" };
  try {
    const root = fs.existsSync(backupConfig().directory) ? backupConfig().directory : process.cwd();
    const stats = fs.statfsSync(root);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const databaseBytes = fs.existsSync(databasePath()) ? fs.statSync(databasePath()).size : 0;
    const required = Math.max(512 * 1024 * 1024, databaseBytes * 3);
    disk = { status: availableBytes >= required ? "ok" : "warn", availableBytes, databaseBytes };
    if (disk.status === "warn") warnings.push("Available disk space is below 512 MiB or three times the database size.");
  } catch {
    disk = { status: "error" };
  }

  const node = { status: nodeSupported() ? "ok" as const : "error" as const, version: process.version, required: ">=22.16 <23" };
  return {
    ok: node.status === "ok" && configuration.status === "ok" && browser.status === "ok" && readiness.ok && disk.status !== "error" && warnings.length === 0,
    release: releaseId(),
    node,
    configuration,
    browser,
    readiness,
    disk,
    warnings
  };
}
