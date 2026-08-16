import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../config.js";

const resolvedDatabasePath = databasePath();
export const databaseDirectory = path.dirname(resolvedDatabasePath);
export const legacyNotesPath = path.join(databaseDirectory, "notes.json");

let connection: DatabaseSync | null = null;

export function database() {
  if (!connection) {
    fs.mkdirSync(databaseDirectory, { recursive: true });
    connection = new DatabaseSync(resolvedDatabasePath);
    connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  return connection;
}

export function withTransaction<T>(operation: (connection: DatabaseSync) => T, mode: "deferred" | "immediate" = "deferred") {
  const connection = database();
  connection.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = operation(connection);
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
