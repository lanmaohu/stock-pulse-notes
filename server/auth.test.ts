import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-http-auth-test-"));
process.env.STOCKPULSE_DB_PATH = path.join(directory, "stockpulse.sqlite");
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "test-access-password";
process.env.SESSION_SECRET = "test-session-secret-with-sufficient-length";
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

test("health is public while workspace APIs require authentication", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);

  const insights = await fetch(`${baseUrl}/api/content-insights`);
  assert.equal(insights.status, 401);

  const unknownApi = await fetch(`${baseUrl}/api/not-a-real-route`);
  assert.equal(unknownApi.status, 401);
});

test("password login issues a secure session cookie and unlocks the workspace", async () => {
  const rejected = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https"
    },
    body: JSON.stringify({ password: "test-access-password" })
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { authenticated: true });

  const setCookie = accepted.headers.get("set-cookie") || "";
  assert.match(setCookie, /stockpulse_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Secure/i);
  const cookie = setCookie.split(";")[0] || "";

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });

  const insights = await fetch(`${baseUrl}/api/content-insights`, { headers: { Cookie: cookie } });
  assert.equal(insights.status, 200);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { authenticated: false });
  assert.match(logout.headers.get("set-cookie") || "", /stockpulse_session=;/);

  const anonymousSession = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(anonymousSession.status, 401);
});

test("webhook keeps its independent bearer-token boundary", async () => {
  const missingToken = await fetch(`${baseUrl}/api/webhooks/hermes/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "test", content: "test" })
  });
  assert.equal(missingToken.status, 401);
});
