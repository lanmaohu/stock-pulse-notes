import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-http-public-test-"));
process.env.STOCKPULSE_DB_PATH = path.join(directory, "stockpulse.sqlite");
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token-with-sufficient-length";
process.env.PLATFORM_CREDENTIALS_KEY = Buffer.alloc(32, 19).toString("base64");

const { app } = await import("./index.js");
const { ensureDatabase } = await import("./db.js");
const server = app.listen(0);
let baseUrl = "";

before(async () => {
  await ensureDatabase();
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("health and website APIs are public", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);

  const insights = await fetch(`${baseUrl}/api/content-insights`);
  assert.equal(insights.status, 200);

  const accounts = await fetch(`${baseUrl}/api/platform-accounts`);
  assert.equal(accounts.status, 200);

  const settings = await fetch(`${baseUrl}/api/collection-settings`);
  assert.equal(settings.status, 200);

  const unknownApi = await fetch(`${baseUrl}/api/not-a-real-route`);
  assert.equal(unknownApi.status, 404);
});

test("legacy website auth endpoints remain harmless no-op compatibility routes", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST" });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: true });

  const session = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { authenticated: true });
});

test("webhook keeps its independent bearer-token boundary", async () => {
  const missingToken = await fetch(`${baseUrl}/api/webhooks/hermes/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "test", content: "test" })
  });
  assert.equal(missingToken.status, 401);
});
