import { database } from "../database/connection.js";

export type ServiceStatus = "starting" | "ready" | "stopping";

export interface ServiceHeartbeat {
  serviceName: string;
  instanceId: string;
  status: ServiceStatus;
  startedAt: string;
  heartbeatAt: string;
}

export function writeServiceHeartbeat(input: ServiceHeartbeat) {
  database().prepare(`
    INSERT INTO service_heartbeats (serviceName, instanceId, status, startedAt, heartbeatAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(serviceName) DO UPDATE SET
      instanceId = excluded.instanceId,
      status = excluded.status,
      startedAt = CASE
        WHEN service_heartbeats.instanceId = excluded.instanceId THEN service_heartbeats.startedAt
        ELSE excluded.startedAt
      END,
      heartbeatAt = excluded.heartbeatAt
  `).run(input.serviceName, input.instanceId, input.status, input.startedAt, input.heartbeatAt);
}

export function getServiceHeartbeat(serviceName: string) {
  return database().prepare("SELECT * FROM service_heartbeats WHERE serviceName = ?").get(serviceName) as ServiceHeartbeat | undefined;
}

export function collectionQueueHealth(now = Date.now()) {
  const row = database().prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      MIN(CASE WHEN status = 'queued' THEN createdAt END) AS oldestQueuedAt,
      SUM(CASE WHEN status = 'running' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?) THEN 1 ELSE 0 END) AS expiredLeases
    FROM collection_runs
  `).get(now) as { queued: number | null; running: number | null; oldestQueuedAt: string | null; expiredLeases: number | null };
  return {
    queued: Number(row.queued || 0),
    running: Number(row.running || 0),
    oldestQueuedAt: row.oldestQueuedAt || undefined,
    expiredLeases: Number(row.expiredLeases || 0)
  };
}
