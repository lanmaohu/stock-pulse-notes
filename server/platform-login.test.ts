import assert from "node:assert/strict";
import { test } from "node:test";
import { hasChangedLoginCookie, pageLooksChallenged, qrUrlFromPayload } from "./platforms/login-state.js";

test("platform QR response payloads expose only supported QR URLs", () => {
  assert.equal(
    qrUrlFromPayload("xiaohongshu", { data: { url: "xhsdiscover://login/qr-value" } }),
    "xhsdiscover://login/qr-value"
  );
  assert.equal(
    qrUrlFromPayload("douyin", { data: { qrcode_index_url: "https://login.douyin.com/qr/value" } }),
    "https://login.douyin.com/qr/value"
  );
  assert.equal(qrUrlFromPayload("douyin", { data: { url: "javascript:alert(1)" } }), undefined);
});

test("challenge detection includes redirect pages and browser-only verification shells", () => {
  assert.equal(pageLooksChallenged({ title: "验证码中间页" }), true);
  assert.equal(pageLooksChallenged({ url: "https://www.xiaohongshu.com/website-login/error" }), true);
  assert.equal(pageLooksChallenged({ title: "抖音-记录美好生活", text: "公开视频" }), false);
  assert.equal(pageLooksChallenged({ hasChallengeElement: true }), true);
});

test("guest login cookies must change before a QR session is confirmed", () => {
  const initial = { web_session: "guest-session" };
  assert.equal(hasChangedLoginCookie([{ name: "web_session", value: "guest-session" }], initial, ["web_session"]), false);
  assert.equal(hasChangedLoginCookie([{ name: "web_session", value: "member-session" }], initial, ["web_session"]), true);
  assert.equal(hasChangedLoginCookie([{ name: "unrelated", value: "value" }], initial, ["web_session"]), false);
});
