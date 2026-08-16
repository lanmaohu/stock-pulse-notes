import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { apiPort, databasePath } from "./config.js";

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
