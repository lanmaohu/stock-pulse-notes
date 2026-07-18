import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-auth-test-"));
process.env.STOCKPULSE_DB_PATH = path.join(directory, "stockpulse.sqlite");
process.env.PLATFORM_CREDENTIALS_KEY = Buffer.alloc(32, 11).toString("base64");

const originalFetch = globalThis.fetch;
let nextPollCode = 86101;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("qrcode/generate")) {
    return jsonResponse({ code: 0, data: { url: "https://passport.bilibili.com/scan/test", qrcode_key: `key-${Date.now()}` } });
  }
  if (url.includes("qrcode/poll")) {
    if (nextPollCode === 0) {
      return jsonResponse({
        code: 0,
        data: {
          code: 0,
          url: "https://www.bilibili.com/?DedeUserID=42&SESSDATA=test-session&bili_jct=test-csrf"
        }
      });
    }
    return jsonResponse({ code: 0, data: { code: nextPollCode } });
  }
  if (url.includes("/x/frontend/finger/spi")) {
    return jsonResponse({ code: 0, data: { b_3: "device-3", b_4: "device-4" } });
  }
  if (url.includes("/x/web-interface/nav")) {
    return jsonResponse({
      code: 0,
      data: {
        isLogin: true,
        mid: 42,
        uname: "测试账号",
        face: "https://i0.hdslb.com/test.jpg",
        wbi_img: {
          img_url: "https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz0123456789abcdef.png",
          sub_url: "https://i0.hdslb.com/bfs/wbi/fedcba9876543210abcdefghijklmnopqrstuvwxyz.png"
        }
      }
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const auth = await import("./bilibili-auth.js");
const db = await import("./db.js");

after(() => {
  globalThis.fetch = originalFetch;
});

test("Bilibili QR sessions report waiting, scanned and expired states", async () => {
  nextPollCode = 86101;
  const waiting = await auth.createBilibiliQrSession();
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.qrImageDataUrl || "", /^data:image\/png;base64,/);
  assert.equal((await auth.pollBilibiliQrSession(waiting.sessionId)).status, "waiting");

  nextPollCode = 86090;
  const scanned = await auth.createBilibiliQrSession();
  assert.equal((await auth.pollBilibiliQrSession(scanned.sessionId)).status, "scanned");

  nextPollCode = 86038;
  const expired = await auth.createBilibiliQrSession();
  assert.equal((await auth.pollBilibiliQrSession(expired.sessionId)).status, "expired");
});

test("confirmed QR login persists only a sanitized platform account", async () => {
  nextPollCode = 0;
  const session = await auth.createBilibiliQrSession();
  const confirmed = await auth.pollBilibiliQrSession(session.sessionId);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.account?.displayName, "测试账号");
  assert.equal(Object.hasOwn(confirmed.account || {}, "credentialsCiphertext"), false);

  const accounts = db.listPlatformAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.externalUserId, "42");
  assert.equal(Object.hasOwn(accounts[0] || {}, "credentialsCiphertext"), false);
});
