import { summarizeDate } from "./ai.js";

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

export function startSummaryScheduler() {
  const cronTime = process.env.SUMMARY_CRON_TIME || "01:00";
  let lastRunKey = "";

  setInterval(() => {
    const now = shanghaiParts();
    const runKey = `${now.date}:${cronTime}`;
    if (now.time !== cronTime || lastRunKey === runKey) {
      return;
    }
    lastRunKey = runKey;
    void summarizeDate(now.date, { fallback: true }).catch((error) => {
      console.error("Scheduled summary failed", error);
    });
  }, 30 * 1000).unref();
}
