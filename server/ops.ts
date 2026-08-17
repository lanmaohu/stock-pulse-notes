import { spawnSync } from "node:child_process";
import { closeDatabase } from "./database/connection.js";
import { createVerifiedBackup, restoreBackup, verifyBackup } from "./operations/backup.js";
import { doctorReport } from "./operations/doctor.js";

function usage(): never {
  process.stderr.write("Usage: npm run ops -- doctor | backup [--reason value] | verify-backup <id> | restore <id> --confirm=RESTORE\n");
  process.exit(2);
}

function option(name: string) {
  const equals = process.argv.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertProcessesStopped() {
  for (const processName of ["stockpulse", "stockpulse-worker"]) {
    const result = spawnSync("pm2", ["pid", processName], { encoding: "utf8" });
    if (result.error) throw new Error("PM2 is required to verify that Stockpulse processes are stopped.");
    const pids = result.stdout.trim().split(/\s+/).filter((value) => /^\d+$/.test(value) && value !== "0");
    if (pids.length) throw new Error(`${processName} is still running. Stop API and Worker before restoring a backup.`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "doctor") {
    const report = await doctorReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "backup") {
    const result = await createVerifiedBackup({ reason: option("--reason") || "manual" });
    process.stdout.write(`${JSON.stringify({ ok: true, backupId: result.manifest.id, directory: result.directory }, null, 2)}\n`);
    return;
  }
  if (command === "verify-backup") {
    const id = process.argv[3] || usage();
    const result = await verifyBackup(id);
    process.stdout.write(`${JSON.stringify({ ok: true, manifest: result.manifest }, null, 2)}\n`);
    return;
  }
  if (command === "restore") {
    const id = process.argv[3] || usage();
    if (option("--confirm") !== "RESTORE") throw new Error("Restore requires --confirm=RESTORE.");
    assertProcessesStopped();
    closeDatabase();
    const result = await restoreBackup(id);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      restoredBackupId: result.restored.manifest.id,
      preRestoreBackupId: result.recovery.manifest.id
    }, null, 2)}\n`);
    return;
  }
  usage();
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
