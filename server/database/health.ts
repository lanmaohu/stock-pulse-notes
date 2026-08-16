import { database } from "./connection.js";

export function databaseIsHealthy() {
  try {
    return (database().prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}
