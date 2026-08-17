import crypto from "node:crypto";
import { writeServiceHeartbeat, type ServiceStatus } from "../repositories/operations.js";

export function createServiceHeartbeat(serviceName: string, intervalMs = 30_000) {
  const instanceId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let status: ServiceStatus = "starting";
  let timer: ReturnType<typeof setInterval> | undefined;

  const write = () => writeServiceHeartbeat({
    serviceName,
    instanceId,
    status,
    startedAt,
    heartbeatAt: new Date().toISOString()
  });

  const start = () => {
    write();
    timer = setInterval(write, intervalMs);
    timer.unref();
  };
  const ready = () => {
    status = "ready";
    write();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    status = "stopping";
    write();
  };
  return { instanceId, start, ready, stop, write };
}
