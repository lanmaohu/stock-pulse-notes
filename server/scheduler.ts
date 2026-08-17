import { enqueueCollection as defaultEnqueueCollection } from "./collection/service.js";
import { getCollectionSettings as defaultGetCollectionSettings } from "./repositories/collection.js";
import { errorFields, log } from "./observability/logger.js";

export function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export interface CollectionSchedulerDependencies {
  now?: () => Date;
  getSettings?: typeof defaultGetCollectionSettings;
  enqueue?: typeof defaultEnqueueCollection;
  intervalMs?: number;
}

export function createCollectionScheduler(dependencies: CollectionSchedulerDependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const getSettings = dependencies.getSettings || defaultGetCollectionSettings;
  const enqueue = dependencies.enqueue || defaultEnqueueCollection;
  let lastAttemptKey = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    const settings = getSettings();
    if (!settings.enabled) return;
    const current = shanghaiParts(now());
    const attemptKey = `${current.date}:${settings.localTime}`;
    if (current.time < settings.localTime || lastAttemptKey === attemptKey) return;
    try {
      enqueue("scheduled", undefined, current.date);
      lastAttemptKey = attemptKey;
    } catch (error) {
      if (error instanceof Error && error.message.includes("还没有启用的博主")) {
        lastAttemptKey = attemptKey;
        return;
      }
      log("error", "scheduled_collection_failed", errorFields(error));
    }
  };

  const start = () => {
    tick();
    timer = setInterval(tick, dependencies.intervalMs ?? 30_000);
    timer.unref();
    return stop;
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return { start, stop, tick };
}

export function startCollectionScheduler(dependencies: CollectionSchedulerDependencies = {}) {
  return createCollectionScheduler(dependencies).start();
}
