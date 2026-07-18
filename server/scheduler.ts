import { enqueueCollection } from "./collector.js";
import { getCollectionSettings } from "./db.js";

function shanghaiParts(date = new Date()) {
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
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

export function startCollectionScheduler() {
  let lastAttemptKey = "";
  const tick = () => {
    const settings = getCollectionSettings();
    if (!settings.enabled) {
      return;
    }
    const now = shanghaiParts();
    const attemptKey = `${now.date}:${settings.localTime}`;
    if (now.time < settings.localTime || lastAttemptKey === attemptKey) {
      return;
    }
    lastAttemptKey = attemptKey;
    try {
      enqueueCollection("scheduled", undefined, now.date);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("还没有启用的博主"))) {
        console.error("Scheduled collection failed", error instanceof Error ? error.message : error);
      }
    }
  };

  tick();
  setInterval(tick, 30 * 1000).unref();
}
