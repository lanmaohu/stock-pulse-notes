import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-operations-test-"));
const databaseFile = path.join(directory, "data", "stockpulse.sqlite");
process.env.STOCKPULSE_DB_PATH = databaseFile;
process.env.STOCKPULSE_BACKUP_DIR = path.join(directory, "backups");
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token-with-sufficient-length";
process.env.PLATFORM_CREDENTIALS_KEY = Buffer.alloc(32, 29).toString("base64");
process.env.SESSION_SECRET = "test-session-secret-with-sufficient-length";
process.env.PORTFOLIO_VIEW_PASSWORD = "viewer-test-password";
process.env.PORTFOLIO_ADMIN_PASSWORD = "admin-test-password";
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

const { ensureDatabase } = await import("./database/migrations.js");
const { closeDatabase, database } = await import("./database/connection.js");
const { createVerifiedBackup, restoreBackup, verifyBackup } = await import("./operations/backup.js");
const { readinessStatus } = await import("./database/health.js");
const { writeServiceHeartbeat } = await import("./repositories/operations.js");
const { createBackupScheduler } = await import("./operations/backup-scheduler.js");

test("SQLite backup captures WAL data, detects corruption, and restores with a recovery point", async () => {
  await ensureDatabase();
  database().prepare(`
    INSERT INTO chat_messages (id, externalId, source, sender, content, messageAt, createdAt)
    VALUES ('before-backup', 'before-backup', 'test', 'tester', 'preserved', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());
  fs.mkdirSync(process.env.STOCKPULSE_BACKUP_DIR!, { recursive: true });
  const lockPath = path.join(process.env.STOCKPULSE_BACKUP_DIR!, ".backup.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await assert.rejects(() => createVerifiedBackup({ reason: "active-lock" }), /already running/);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, createdAt: new Date().toISOString() }));
  const created = await createVerifiedBackup({ reason: "test-wal" });
  const verified = await verifyBackup(created.manifest.id);
  assert.equal(verified.manifest.tableCounts.chat_messages, 1);
  assert.match(verified.manifest.databaseSha256, /^[a-f0-9]{64}$/);

  const corruptId = `${created.manifest.id}-corrupt`;
  const corruptDirectory = path.join(process.env.STOCKPULSE_BACKUP_DIR!, corruptId);
  fs.cpSync(created.directory, corruptDirectory, { recursive: true });
  const corruptManifestPath = path.join(corruptDirectory, "manifest.json");
  const corruptManifest = JSON.parse(fs.readFileSync(corruptManifestPath, "utf8")) as Record<string, unknown>;
  corruptManifest.id = corruptId;
  fs.writeFileSync(corruptManifestPath, `${JSON.stringify(corruptManifest)}\n`);
  fs.appendFileSync(path.join(corruptDirectory, "stockpulse.sqlite"), "corrupt");
  await assert.rejects(() => verifyBackup(corruptId), /checksum/);

  database().prepare(`
    INSERT INTO chat_messages (id, externalId, source, sender, content, messageAt, createdAt)
    VALUES ('after-backup', 'after-backup', 'test', 'tester', 'removed by restore', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());
  closeDatabase();
  const restored = await restoreBackup(created.manifest.id);
  assert.equal(restored.restored.manifest.id, created.manifest.id);
  assert.match(restored.recovery.manifest.reason, /^pre-restore-/);
  const read = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal((read.prepare("SELECT COUNT(*) AS count FROM chat_messages").get() as { count: number }).count, 1);
  read.close();
});

test("readiness reports healthy and stale worker heartbeats", async () => {
  const now = Date.now();
  writeServiceHeartbeat({
    serviceName: "worker",
    instanceId: "worker-test",
    status: "ready",
    startedAt: new Date(now - 1_000).toISOString(),
    heartbeatAt: new Date(now).toISOString()
  });
  const healthy = await readinessStatus(now);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checks.worker, "ok");
  assert.equal(healthy.checks.backup, "ok");

  writeServiceHeartbeat({
    serviceName: "worker",
    instanceId: "worker-test",
    status: "ready",
    startedAt: new Date(now - 200_000).toISOString(),
    heartbeatAt: new Date(now - 91_000).toISOString()
  });
  const stale = await readinessStatus(now);
  assert.equal(stale.ok, false);
  assert.equal(stale.checks.worker, "stale");
});

test("daily backup scheduler is idempotent for one Shanghai date", async () => {
  let created = 0;
  const scheduler = createBackupScheduler({
    now: () => new Date("2026-08-17T20:00:00.000Z"),
    localTime: "03:15",
    backups: async () => [],
    createBackup: async (options) => {
      created += 1;
      return {
        directory,
        manifest: { reason: options.reason } as Awaited<ReturnType<typeof createVerifiedBackup>>["manifest"]
      };
    }
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(created, 1);
});
