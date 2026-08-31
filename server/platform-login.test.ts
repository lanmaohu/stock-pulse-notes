import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasChangedLoginCookie,
  matchesQrResponsePath,
  pageLooksChallenged,
  qrUrlFromPayload,
  webLoginProgress
} from "./platforms/login-state.js";

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

test("QR response matching tolerates a trailing slash but rejects other endpoints", () => {
  assert.equal(matchesQrResponsePath(
    "https://sso.douyin.com/passport/web/get_qrcode/?service=creator",
    "/passport/web/get_qrcode/"
  ), true);
  assert.equal(matchesQrResponsePath(
    "https://www.xiaohongshu.com/api/sns/web/v1/login/qrcode/create",
    "/api/sns/web/v1/login/qrcode/create"
  ), true);
  assert.equal(matchesQrResponsePath("not-a-url", "/passport/web/get_qrcode/"), false);
  assert.equal(matchesQrResponsePath("https://example.com/passport/web/check_qrcode", "/passport/web/get_qrcode/"), false);
});

test("a disappearing QR is only scanned and a fresh login cookie is required before verification", () => {
  assert.equal(webLoginProgress({
    hasFreshLoginCookie: false,
    qrElementObserved: true,
    qrElementVisible: true
  }), "waiting");
  assert.equal(webLoginProgress({
    hasFreshLoginCookie: false,
    qrElementObserved: true,
    qrElementVisible: false
  }), "scanned");
  assert.equal(webLoginProgress({
    hasFreshLoginCookie: true,
    qrElementObserved: false,
    qrElementVisible: false
  }), "verify");
});
