import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { apiPort, backupConfig, databasePath, platformBrowserHeadless, platformBrowserProxy } from "./config.js";

test("API port validation rejects malformed and out-of-range values", () => {
  const previous = process.env.PORT;
  try {
    process.env.PORT = "not-a-number";
    assert.throws(() => apiPort(), /PORT must be an integer/);
    process.env.PORT = "70000";
    assert.throws(() => apiPort(), /PORT must be an integer/);
    process.env.PORT = "3000";
    assert.equal(apiPort(), 3000);
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
  }
});

test("database path is explicit and cannot be blank", () => {
  const previous = process.env.STOCKPULSE_DB_PATH;
  try {
    process.env.STOCKPULSE_DB_PATH = "";
    assert.throws(() => databasePath(), /cannot be empty/);
    process.env.STOCKPULSE_DB_PATH = "data/test.sqlite";
    assert.equal(databasePath(), path.resolve("data/test.sqlite"));
  } finally {
    if (previous === undefined) delete process.env.STOCKPULSE_DB_PATH;
    else process.env.STOCKPULSE_DB_PATH = previous;
  }
});

test("backup settings validate schedule and retention bounds", () => {
  const previousTime = process.env.BACKUP_LOCAL_TIME;
  const previousRetention = process.env.BACKUP_RETENTION_DAYS;
  try {
    process.env.BACKUP_LOCAL_TIME = "25:00";
    assert.throws(() => backupConfig(), /HH:MM/);
    process.env.BACKUP_LOCAL_TIME = "03:15";
    process.env.BACKUP_RETENTION_DAYS = "0";
    assert.throws(() => backupConfig(), /between 1 and 3650/);
    process.env.BACKUP_RETENTION_DAYS = "30";
    assert.equal(backupConfig().retentionDays, 30);
  } finally {
    if (previousTime === undefined) delete process.env.BACKUP_LOCAL_TIME;
    else process.env.BACKUP_LOCAL_TIME = previousTime;
    if (previousRetention === undefined) delete process.env.BACKUP_RETENTION_DAYS;
    else process.env.BACKUP_RETENTION_DAYS = previousRetention;
  }
});

test("platform browser mode and optional proxy are validated", () => {
  const previousHeadless = process.env.PLATFORM_BROWSER_HEADLESS;
  const previousServer = process.env.PLATFORM_BROWSER_PROXY_SERVER;
  const previousUsername = process.env.PLATFORM_BROWSER_PROXY_USERNAME;
  const previousPassword = process.env.PLATFORM_BROWSER_PROXY_PASSWORD;
  try {
    process.env.PLATFORM_BROWSER_HEADLESS = "false";
    assert.equal(platformBrowserHeadless(), false);
    process.env.PLATFORM_BROWSER_HEADLESS = "sometimes";
    assert.throws(() => platformBrowserHeadless(), /true or false/);

    process.env.PLATFORM_BROWSER_PROXY_SERVER = "http://proxy.example:8080";
    process.env.PLATFORM_BROWSER_PROXY_USERNAME = "collector";
    delete process.env.PLATFORM_BROWSER_PROXY_PASSWORD;
    assert.deepEqual(platformBrowserProxy(), {
      server: "http://proxy.example:8080",
      username: "collector",
      password: undefined
    });
    process.env.PLATFORM_BROWSER_PROXY_SERVER = "http://user:secret@proxy.example:8080";
    assert.throws(() => platformBrowserProxy(), /without embedded credentials/);
  } finally {
    if (previousHeadless === undefined) delete process.env.PLATFORM_BROWSER_HEADLESS;
    else process.env.PLATFORM_BROWSER_HEADLESS = previousHeadless;
    if (previousServer === undefined) delete process.env.PLATFORM_BROWSER_PROXY_SERVER;
    else process.env.PLATFORM_BROWSER_PROXY_SERVER = previousServer;
    if (previousUsername === undefined) delete process.env.PLATFORM_BROWSER_PROXY_USERNAME;
    else process.env.PLATFORM_BROWSER_PROXY_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.PLATFORM_BROWSER_PROXY_PASSWORD;
    else process.env.PLATFORM_BROWSER_PROXY_PASSWORD = previousPassword;
  }
});
