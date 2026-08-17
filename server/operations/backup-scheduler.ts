import { backupConfig } from "../config.js";
import { errorFields, log } from "../observability/logger.js";
import { shanghaiParts } from "../scheduler.js";
import { createVerifiedBackup, listBackups } from "./backup.js";

export interface BackupSchedulerDependencies {
  now?: () => Date;
  createBackup?: typeof createVerifiedBackup;
  backups?: typeof listBackups;
  intervalMs?: number;
  localTime?: string;
}

export function createBackupScheduler(dependencies: BackupSchedulerDependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const createBackup = dependencies.createBackup || createVerifiedBackup;
  const backups = dependencies.backups || listBackups;
  const localTime = dependencies.localTime || backupConfig().localTime;
  let lastAttemptDate = "";
  let lastFailureAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | null = null;

  const tick = async () => {
    if (active) return active;
    const current = shanghaiParts(now());
    if (current.time < localTime || lastAttemptDate === current.date) return;
    if (lastFailureAt && now().getTime() - lastFailureAt < 60 * 60 * 1_000) return;
    const reason = `scheduled-${current.date}`;
    active = (async () => {
      try {
        const existing = (await backups()).find((item) => item.manifest.reason === reason);
        if (!existing) {
          const created = await createBackup({ reason });
          log("info", "database_backup_completed", { backupId: created.manifest.id, reason });
        }
        lastAttemptDate = current.date;
      } catch (error) {
        lastFailureAt = now().getTime();
        log("error", "database_backup_failed", { reason, ...errorFields(error) });
      }
    })();
    try {
      await active;
    } finally {
      active = null;
    }
  };

  const start = () => {
    void tick();
    timer = setInterval(() => void tick(), dependencies.intervalMs ?? 60_000);
    timer.unref();
    return stop;
  };
  const stop = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await active;
  };
  return { start, stop, tick };
}
