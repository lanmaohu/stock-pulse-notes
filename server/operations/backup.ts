import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { backupConfig, databasePath, releaseId } from "../config.js";

export interface BackupManifest {
  version: 1;
  id: string;
  reason: string;
  createdAt: string;
  release: string;
  node: string;
  databaseFile: "stockpulse.sqlite";
  databaseBytes: number;
  databaseSha256: string;
  sourcePathSha256: string;
  quickCheck: "ok";
  migrations: string[];
  tableCounts: Record<string, number>;
  environmentIncluded: boolean;
}

export interface BackupVerification {
  directory: string;
  manifest: BackupManifest;
}

const lockName = ".backup.lock";

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

function assertBackupId(id: string) {
  if (id !== path.basename(id) || !/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid backup ID.");
  return id;
}

function sha256(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function databaseSourceHash(file = databasePath()) {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // A new database does not have a real path yet; its absolute path is still a stable identity.
  }
  return crypto.createHash("sha256").update(resolved).digest("hex");
}

function inspectDatabase(file: string) {
  const connection = new DatabaseSync(file, { readOnly: true });
  try {
    const quickRows = connection.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (quickRows.length !== 1 || quickRows[0]?.quick_check !== "ok") {
      throw new Error(`Backup database quick_check failed: ${quickRows.map((row) => row.quick_check).join(", ")}`);
    }
    const tables = connection.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const tableCounts: Record<string, number> = {};
    for (const { name } of tables) {
      const quoted = name.replaceAll('"', '""');
      const row = connection.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get() as { count: number };
      tableCounts[name] = Number(row.count);
    }
    const migrations = tableCounts.schema_migrations === undefined
      ? []
      : (connection.prepare("SELECT name FROM schema_migrations ORDER BY appliedAt, name").all() as Array<{ name: string }>).map((row) => row.name);
    return { quickCheck: "ok" as const, tableCounts, migrations };
  } finally {
    connection.close();
  }
}

async function withBackupLock<T>(operation: () => Promise<T>) {
  const config = backupConfig();
  await fsp.mkdir(config.directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(config.directory, 0o700);
  const lockPath = path.join(config.directory, lockName);
  let handle: fsp.FileHandle | undefined;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lock = JSON.parse(await fsp.readFile(lockPath, "utf8")) as { pid?: number; createdAt?: string };
        const age = Date.now() - Date.parse(lock.createdAt || "");
        if (!Number.isFinite(age) || age > 2 * 60 * 60 * 1_000 || !lock.pid) stale = true;
        else {
          try {
            process.kill(lock.pid, 0);
          } catch (signalError) {
            if ((signalError as NodeJS.ErrnoException).code === "ESRCH") stale = true;
          }
        }
      } catch {
        stale = true;
      }
      if (!stale || attempt > 0) throw new Error("Another database backup is already running.");
      await fsp.unlink(lockPath).catch(() => undefined);
    }
  }
  if (!handle) throw new Error("Could not acquire the database backup lock.");
  try {
    return await operation();
  } finally {
    await handle.close();
    await fsp.unlink(lockPath).catch(() => undefined);
  }
}

function backupId(reason: string, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `${stamp}-${safeSegment(releaseId())}-${safeSegment(reason)}`;
}

export async function createVerifiedBackup(options: {
  reason: string;
  includeEnvironment?: boolean;
  sourcePath?: string;
  now?: Date;
}): Promise<BackupVerification> {
  return withBackupLock(async () => {
    const config = backupConfig();
    const sourcePath = path.resolve(options.sourcePath || databasePath());
    if (!fs.existsSync(sourcePath)) throw new Error(`Database file does not exist: ${sourcePath}`);
    const id = backupId(options.reason, options.now);
    const destination = path.join(config.directory, id);
    if (fs.existsSync(destination)) return verifyBackup(id);
    const partial = path.join(config.directory, `.partial-${id}-${crypto.randomUUID()}`);
    await fsp.mkdir(partial, { mode: 0o700 });
    try {
      const databaseFile = path.join(partial, "stockpulse.sqlite");
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        await backup(source, databaseFile, { rate: 100 });
      } finally {
        source.close();
      }
      await fsp.chmod(databaseFile, 0o600);
      const inspection = inspectDatabase(databaseFile);
      const stats = await fsp.stat(databaseFile);
      const includeEnvironment = options.includeEnvironment !== false;
      const envPath = path.join(process.cwd(), ".env");
      let environmentIncluded = false;
      if (includeEnvironment && fs.existsSync(envPath)) {
        await fsp.copyFile(envPath, path.join(partial, "environment.env"));
        await fsp.chmod(path.join(partial, "environment.env"), 0o600);
        environmentIncluded = true;
      }
      const manifest: BackupManifest = {
        version: 1,
        id,
        reason: safeSegment(options.reason),
        createdAt: (options.now || new Date()).toISOString(),
        release: releaseId(),
        node: process.version,
        databaseFile: "stockpulse.sqlite",
        databaseBytes: stats.size,
        databaseSha256: await sha256(databaseFile),
        sourcePathSha256: databaseSourceHash(sourcePath),
        quickCheck: inspection.quickCheck,
        migrations: inspection.migrations,
        tableCounts: inspection.tableCounts,
        environmentIncluded
      };
      await fsp.writeFile(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fsp.rename(partial, destination);
      await pruneBackups();
      return { directory: destination, manifest };
    } catch (error) {
      await fsp.rm(partial, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function verifyBackup(id: string, options: { maximumAgeMs?: number } = {}): Promise<BackupVerification> {
  const config = backupConfig();
  const safeId = assertBackupId(id);
  const directory = path.join(config.directory, safeId);
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.version !== 1 || manifest.id !== safeId || manifest.databaseFile !== "stockpulse.sqlite") {
    throw new Error("Backup manifest is invalid.");
  }
  const createdAt = Date.parse(manifest.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error("Backup manifest has an invalid timestamp.");
  if (options.maximumAgeMs !== undefined && Date.now() - createdAt > options.maximumAgeMs) {
    throw new Error("Backup is too old for this operation.");
  }
  const databaseFile = path.join(directory, manifest.databaseFile);
  const stats = await fsp.stat(databaseFile);
  if (stats.size !== manifest.databaseBytes || await sha256(databaseFile) !== manifest.databaseSha256) {
    throw new Error("Backup checksum does not match its manifest.");
  }
  const inspection = inspectDatabase(databaseFile);
  if (JSON.stringify(inspection.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw new Error("Backup table counts do not match its manifest.");
  }
  return { directory, manifest };
}

export async function listBackups() {
  const config = backupConfig();
  await fsp.mkdir(config.directory, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(config.directory, { withFileTypes: true });
  const backups: BackupVerification[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      backups.push(await verifyBackup(entry.name));
    } catch {
      // Corrupt backup directories stay on disk for manual inspection, but never count as valid recovery points.
    }
  }
  return backups.sort((left, right) => Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt));
}

export async function latestBackup() {
  const sourcePathSha256 = databaseSourceHash();
  const config = backupConfig();
  await fsp.mkdir(config.directory, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(config.directory, { withFileTypes: true });
  const candidates: BackupManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(config.directory, entry.name, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.id === entry.name && manifest.sourcePathSha256 === sourcePathSha256) candidates.push(manifest);
    } catch {
      // Ignore incomplete manifests and try older recovery points.
    }
  }
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  for (const manifest of candidates) {
    try {
      return await verifyBackup(manifest.id);
    } catch {
      // A corrupt newest backup must not hide an older valid recovery point.
    }
  }
  return null;
}

export async function pruneBackups(now = Date.now()) {
  const config = backupConfig();
  const backups = await listBackups();
  const protectedIds = new Set(backups.slice(0, config.minimumCount).map((item) => item.manifest.id));
  for (const item of backups) {
    if (protectedIds.has(item.manifest.id)) continue;
    if (now - Date.parse(item.manifest.createdAt) <= config.retentionDays * 86_400_000) continue;
    await fsp.rm(item.directory, { recursive: true });
  }
}

export async function restoreBackup(id: string) {
  const verified = await verifyBackup(id);
  const expectedSource = databaseSourceHash();
  if (verified.manifest.sourcePathSha256 !== expectedSource) throw new Error("Backup belongs to a different database path.");
  const recovery = await createVerifiedBackup({ reason: `pre-restore-${id}` });
  const target = databasePath();
  const temporary = `${target}.restore-${crypto.randomUUID()}`;
  await fsp.copyFile(path.join(verified.directory, verified.manifest.databaseFile), temporary);
  inspectDatabase(temporary);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${target}${suffix}`;
    if (fs.existsSync(sidecar)) {
      await fsp.rename(sidecar, path.join(recovery.directory, `previous${suffix}`));
    }
  }
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600);
  return { restored: verified, recovery };
}
