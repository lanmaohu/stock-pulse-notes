import crypto from "node:crypto";
import type {
  CollectionRun,
  CollectionRunItem,
  CollectionRunStatus,
  CollectionRunTrigger,
  CollectionSettings,
  Creator
} from "../../shared/types.js";
import { database, withTransaction } from "../database/connection.js";
import { optionalString, sqliteBoolean } from "../database/rows.js";

type CollectionRunRow = Omit<CollectionRun, "items" | "scheduledFor" | "error" | "startedAt" | "completedAt"> & {
  scheduledFor: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
};

type CollectionRunItemRow = Omit<CollectionRunItem, "errorCode" | "error" | "startedAt" | "completedAt"> & {
  errorCode: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

function toItem(row: CollectionRunItemRow): CollectionRunItem {
  return {
    ...row,
    errorCode: optionalString(row.errorCode),
    error: optionalString(row.error),
    startedAt: optionalString(row.startedAt),
    completedAt: optionalString(row.completedAt)
  };
}

function items(runId: string) {
  return (database()
    .prepare("SELECT * FROM collection_run_items WHERE runId = ? ORDER BY rowid ASC")
    .all(runId) as CollectionRunItemRow[]).map(toItem);
}

function toRun(row: CollectionRunRow): CollectionRun {
  const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...safe } = row;
  return {
    ...safe,
    scheduledFor: optionalString(row.scheduledFor),
    error: optionalString(row.error),
    startedAt: optionalString(row.startedAt),
    completedAt: optionalString(row.completedAt),
    items: items(row.id)
  };
}

export function getCollectionRun(id: string): CollectionRun | null {
  const row = database().prepare("SELECT * FROM collection_runs WHERE id = ?").get(id) as CollectionRunRow | undefined;
  return row ? toRun(row) : null;
}

export function listCollectionRuns(limit = 30): CollectionRun[] {
  const rows = database()
    .prepare("SELECT * FROM collection_runs ORDER BY datetime(createdAt) DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 100)) as CollectionRunRow[];
  return rows.map(toRun);
}

export function createCollectionRun(
  trigger: CollectionRunTrigger,
  creators: Creator[],
  scheduledFor?: string
): { run: CollectionRun; created: boolean } {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = withTransaction((connection) => {
    if (trigger === "scheduled" && scheduledFor) {
      const existing = connection
        .prepare("SELECT id FROM collection_runs WHERE trigger = 'scheduled' AND scheduledFor = ?")
        .get(scheduledFor) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
    }
    connection.prepare(`
      INSERT INTO collection_runs (
        id, trigger, status, scheduledFor, creatorCount, discoveredCount, newContentCount,
        analyzedCount, errorCount, error, startedAt, completedAt, createdAt
      ) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?)
    `).run(id, trigger, scheduledFor || null, creators.length, now);
    const insert = connection.prepare(`
      INSERT INTO collection_run_items (
        id, runId, creatorId, creatorName, status, discoveredCount, newContentCount, analyzedCount,
        errorCode, error, startedAt, completedAt
      ) VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, NULL, NULL, NULL, NULL)
    `);
    for (const creator of creators) insert.run(crypto.randomUUID(), id, creator.id, creator.name);
    return { id, created: true };
  }, "immediate");
  return { run: getCollectionRun(result.id)!, created: result.created };
}

export function getNextQueuedCollectionRun() {
  const row = database()
    .prepare("SELECT * FROM collection_runs WHERE status = 'queued' ORDER BY datetime(createdAt) ASC LIMIT 1")
    .get() as CollectionRunRow | undefined;
  return row ? toRun(row) : null;
}

function claimNextQueuedRunId(
  leaseOwner = "single-worker",
  leaseExpiresAt = Date.now() + 2 * 60 * 1000
) {
  return withTransaction((connection) => {
    const now = Date.now();
    const queued = connection.prepare(`
      SELECT id, status FROM collection_runs
      WHERE status = 'queued' OR (status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?))
      ORDER BY datetime(createdAt) ASC, rowid ASC LIMIT 1
    `).get(now) as { id: string; status: CollectionRunStatus } | undefined;
    if (!queued) return null;
    if (queued.status === "running") {
      connection.prepare(`
        UPDATE collection_run_items
        SET status = 'queued', startedAt = NULL, completedAt = NULL, errorCode = NULL, error = NULL
        WHERE runId = ? AND status = 'running'
      `).run(queued.id);
    }
    const result = connection.prepare(`
      UPDATE collection_runs
      SET status = 'running', startedAt = COALESCE(startedAt, ?), completedAt = NULL, error = NULL,
          leaseOwner = ?, leaseExpiresAt = ?
      WHERE id = ? AND (status = 'queued' OR (status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)))
    `).run(new Date().toISOString(), leaseOwner, leaseExpiresAt, queued.id, now);
    return Number(result.changes) === 1 ? queued.id : null;
  }, "immediate") satisfies string | null;
}

export function claimNextQueuedCollectionRun(leaseOwner?: string, leaseExpiresAt?: number) {
  const id = claimNextQueuedRunId(leaseOwner, leaseExpiresAt);
  return id ? getCollectionRun(id) : null;
}

export function renewCollectionRunLease(id: string, leaseOwner: string, leaseExpiresAt: number) {
  const result = database()
    .prepare("UPDATE collection_runs SET leaseExpiresAt = ? WHERE id = ? AND status = 'running' AND leaseOwner = ?")
    .run(leaseExpiresAt, id, leaseOwner);
  return Number(result.changes) === 1;
}

function itemLeaseClause(leaseOwner?: string) {
  return leaseOwner
    ? " AND EXISTS (SELECT 1 FROM collection_runs r WHERE r.id = collection_run_items.runId AND r.status = 'running' AND r.leaseOwner = ?)"
    : "";
}

export function startCollectionRunItem(id: string, leaseOwner?: string) {
  const values = leaseOwner ? [new Date().toISOString(), id, leaseOwner] : [new Date().toISOString(), id];
  const result = database().prepare(`
    UPDATE collection_run_items SET status = 'running', startedAt = ?, completedAt = NULL, errorCode = NULL, error = NULL
    WHERE id = ? AND status = 'queued'${itemLeaseClause(leaseOwner)}
  `).run(...values);
  return Number(result.changes) === 1;
}

export function finishCollectionRunItem(
  id: string,
  input: {
    status: "success" | "error";
    discoveredCount?: number;
    newContentCount?: number;
    analyzedCount?: number;
    errorCode?: string;
    error?: string;
  },
  leaseOwner?: string
) {
  const values: Array<string | number | null> = [
    input.status,
    input.discoveredCount || 0,
    input.newContentCount || 0,
    input.analyzedCount || 0,
    input.errorCode || null,
    input.error || null,
    new Date().toISOString(),
    id
  ];
  if (leaseOwner) values.push(leaseOwner);
  const result = database().prepare(`
    UPDATE collection_run_items
    SET status = ?, discoveredCount = ?, newContentCount = ?, analyzedCount = ?,
        errorCode = ?, error = ?, completedAt = ?
    WHERE id = ?${itemLeaseClause(leaseOwner)}
  `).run(...values);
  return Number(result.changes) === 1;
}

export function finishCollectionRun(id: string, fatalError?: string, leaseOwner?: string) {
  return withTransaction((connection) => {
    if (leaseOwner && !connection
      .prepare("SELECT 1 FROM collection_runs WHERE id = ? AND status = 'running' AND leaseOwner = ?")
      .get(id, leaseOwner)) return null;
    if (fatalError) {
      connection.prepare(`
        UPDATE collection_run_items
        SET status = 'error', errorCode = 'worker_failed', error = ?, completedAt = ?
        WHERE runId = ? AND status IN ('queued', 'running')
      `).run(fatalError.slice(0, 1_000), new Date().toISOString(), id);
    }
    const totals = connection.prepare(`
      SELECT
        COALESCE(SUM(discoveredCount), 0) AS discoveredCount,
        COALESCE(SUM(newContentCount), 0) AS newContentCount,
        COALESCE(SUM(analyzedCount), 0) AS analyzedCount,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorCount,
        COUNT(*) AS creatorCount
      FROM collection_run_items WHERE runId = ?
    `).get(id) as {
      discoveredCount: number;
      newContentCount: number;
      analyzedCount: number;
      errorCount: number;
      creatorCount: number;
    };
    let status: CollectionRunStatus = "success";
    if (fatalError || (totals.creatorCount > 0 && totals.errorCount === totals.creatorCount)) status = "error";
    else if (totals.errorCount > 0) status = "partial";
    const values: Array<string | number | null> = [
      status,
      totals.creatorCount,
      totals.discoveredCount,
      totals.newContentCount,
      totals.analyzedCount,
      totals.errorCount,
      fatalError || null,
      new Date().toISOString(),
      id
    ];
    if (leaseOwner) values.push(leaseOwner);
    const result = connection.prepare(`
      UPDATE collection_runs
      SET status = ?, creatorCount = ?, discoveredCount = ?, newContentCount = ?, analyzedCount = ?,
          errorCount = ?, error = ?, completedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL
      WHERE id = ?${leaseOwner ? " AND status = 'running' AND leaseOwner = ?" : ""}
    `).run(...values);
    return Number(result.changes) === 1 ? getCollectionRun(id)! : null;
  }, "immediate");
}

export function releaseCollectionRun(id: string, leaseOwner: string) {
  return withTransaction((connection) => {
    const owned = connection
      .prepare("SELECT 1 FROM collection_runs WHERE id = ? AND status = 'running' AND leaseOwner = ?")
      .get(id, leaseOwner);
    if (!owned) return false;
    connection.prepare(`
      UPDATE collection_run_items
      SET status = 'queued', startedAt = NULL, completedAt = NULL, errorCode = NULL, error = NULL
      WHERE runId = ? AND status = 'running'
    `).run(id);
    connection.prepare(`
      UPDATE collection_runs
      SET status = 'queued', completedAt = NULL, leaseOwner = NULL, leaseExpiresAt = NULL
      WHERE id = ? AND leaseOwner = ?
    `).run(id, leaseOwner);
    return true;
  }, "immediate");
}

export function recoverInterruptedCollectionRuns(now = Date.now()) {
  return withTransaction((connection) => {
    const expired = connection.prepare(`
      SELECT id FROM collection_runs
      WHERE status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
    `).all(now) as Array<{ id: string }>;
    const ids = expired.map((row) => row.id);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    connection.prepare(`
      UPDATE collection_runs
      SET status = 'queued', startedAt = NULL, completedAt = NULL, leaseOwner = NULL, leaseExpiresAt = NULL
      WHERE id IN (${placeholders})
    `).run(...ids);
    connection.prepare(`
      UPDATE collection_run_items
      SET status = 'queued', startedAt = NULL, completedAt = NULL, errorCode = NULL, error = NULL
      WHERE status = 'running' AND runId IN (${placeholders})
    `).run(...ids);
    return ids.length;
  }, "immediate");
}

export function getCollectionSettings(): CollectionSettings {
  const row = database().prepare("SELECT * FROM collection_settings WHERE id = 'owner'").get() as {
    enabled: number;
    localTime: string;
    timezone: "Asia/Shanghai";
    maxVideosPerCreator: number;
    updatedAt: string;
  };
  return { ...row, enabled: sqliteBoolean(row.enabled) };
}

export function updateCollectionSettings(input: { enabled: boolean; localTime: string; maxVideosPerCreator: number }) {
  const now = new Date().toISOString();
  database().prepare(`
    UPDATE collection_settings SET enabled = ?, localTime = ?, maxVideosPerCreator = ?, updatedAt = ? WHERE id = 'owner'
  `).run(input.enabled ? 1 : 0, input.localTime, input.maxVideosPerCreator, now);
  return getCollectionSettings();
}
