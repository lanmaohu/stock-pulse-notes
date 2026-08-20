import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrowserCredential } from "./platforms/browser.js";
import { parseDouyinAwemes, parseDouyinUsers } from "./platforms/douyin.js";
import { parseTwitterPosts, parseTwitterUsers } from "./platforms/twitter.js";
import { parseXiaohongshuNotes, parseXiaohongshuUsers } from "./platforms/xiaohongshu.js";
import { closeTwitterOAuthSessions, createTwitterOAuthSession, parseTwitterCredential } from "./twitter-auth.js";

test("Douyin response fixtures produce stable creators and deduplicated works", () => {
  const payload = {
    data: [{ user_info: {
      sec_uid: "MS4wLjABAAAA-test-creator-1234567890",
      nickname: "抖音测试博主",
      unique_id: "test-douyin",
      follower_count: 12345,
      avatar_thumb: { url_list: ["https://example.com/douyin-avatar.jpg"] }
    } }],
    aweme_list: [{
      aweme_id: "7523456789012345678",
      desc: "看好测试行业",
      create_time: 1_765_843_200,
      author: { sec_uid: "MS4wLjABAAAA-test-creator-1234567890" },
      video: { cover: { url_list: ["https://example.com/douyin-cover.jpg"] } }
    }, {
      aweme_id: "7523456789012345678",
      desc: "重复作品",
      video: {}
    }]
  };
  const users = parseDouyinUsers(payload);
  assert.equal(users.length, 1);
  assert.equal(users[0]?.name, "抖音测试博主");
  assert.equal(users[0]?.followerCount, 12345);
  assert.match(users[0]?.profileUrl || "", /\/user\/MS4w/);
  const works = parseDouyinAwemes(payload);
  assert.equal(works.length, 1);
  assert.equal(works[0]?.aweme_id, "7523456789012345678");
});

test("Xiaohongshu response fixtures preserve creator and xsec note identity", () => {
  const payload = {
    users: [{
      user_id: "66abcdeffedcba0011223344",
      nickname: "小红书测试博主",
      red_id: "red-test",
      fans: "9876",
      image: "https://example.com/xhs-avatar.jpg"
    }],
    notes: [{
      note_id: "66fedcba0011223344556677",
      xsec_token: "secret-navigation-token",
      note_card: { title: "测试笔记", desc: "正文内容", type: "normal" }
    }, {
      note_id: "66fedcba0011223344556677",
      display_title: "重复笔记"
    }]
  };
  const users = parseXiaohongshuUsers(payload);
  assert.equal(users.length, 1);
  assert.equal(users[0]?.handle, "red-test");
  assert.equal(users[0]?.followerCount, 9876);
  const selfInfo = parseXiaohongshuUsers({
    data: { result: { success: true, data: {
      user_id: "66abcdeffedcba0011223344",
      nickname: "当前小红书账号",
      image: "https://example.com/xhs-self-avatar.jpg"
    } } }
  });
  assert.equal(selfInfo[0]?.name, "当前小红书账号");
  const notes = parseXiaohongshuNotes(payload);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.xsecToken, "secret-navigation-token");
  assert.equal(notes[0]?.raw.desc, "正文内容");
});

test("browser credentials are platform-bound and reject malformed plaintext", () => {
  const credential = JSON.stringify({
    version: 1,
    platform: "douyin",
    userAgent: "test-agent",
    storageState: { cookies: [], origins: [] }
  });
  assert.equal(parseBrowserCredential("douyin", credential).userAgent, "test-agent");
  assert.throws(() => parseBrowserCredential("xiaohongshu", credential), /凭证格式无效/);
  assert.throws(() => parseBrowserCredential("douyin", "Cookie=plaintext"), /凭证已损坏/);
});

test("Twitter response fixtures preserve account, full post body, tags and media identity", () => {
  const payload = {
    data: [{
      id: "2244994945",
      name: "X Developers",
      username: "XDevelopers",
      profile_image_url: "https://example.com/x-avatar.jpg",
      public_metrics: { followers_count: 123456 }
    }]
  };
  const users = parseTwitterUsers(payload);
  assert.equal(users.length, 1);
  assert.equal(users[0]?.externalId, "2244994945");
  assert.equal(users[0]?.handle, "@XDevelopers");
  assert.equal(users[0]?.followerCount, 123456);

  const posts = parseTwitterPosts({
    data: [{
      id: "1999999999999999999",
      text: "截断正文",
      note_tweet: { text: "完整的长帖正文 #AI $NVDA" },
      created_at: "2026-08-20T03:00:00.000Z",
      entities: { hashtags: [{ tag: "AI" }], cashtags: [{ tag: "NVDA" }] },
      attachments: { media_keys: ["3_123"] }
    }]
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.text, "完整的长帖正文 #AI $NVDA");
  assert.deepEqual(posts[0]?.tags, ["AI", "NVDA"]);
  assert.deepEqual(posts[0]?.mediaKeys, ["3_123"]);
});

test("Twitter OAuth credentials are versioned and reject plaintext tokens", () => {
  const credential = JSON.stringify({
    version: 1,
    platform: "twitter",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "bearer",
    scopes: ["tweet.read", "users.read", "offline.access"],
    expiresAt: "2026-08-20T05:00:00.000Z"
  });
  assert.equal(parseTwitterCredential(credential).refreshToken, "refresh-token");
  assert.throws(() => parseTwitterCredential("access-token"), /凭据已损坏/);
});

test("Twitter OAuth start uses PKCE S256, read-only scopes and an expiring state", () => {
  const previousClientId = process.env.TWITTER_CLIENT_ID;
  const previousSecret = process.env.TWITTER_CLIENT_SECRET;
  const previousCallback = process.env.TWITTER_OAUTH_CALLBACK_URL;
  try {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    delete process.env.TWITTER_CLIENT_SECRET;
    process.env.TWITTER_OAUTH_CALLBACK_URL = "https://stockpulse.example/api/platform-oauth/twitter/callback";
    const session = createTwitterOAuthSession();
    const authorizeUrl = new URL(session.authorizeUrl);
    assert.equal(authorizeUrl.origin, "https://x.com");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizeUrl.searchParams.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(authorizeUrl.searchParams.get("scope")?.split(" "), ["tweet.read", "users.read", "offline.access"]);
    assert.ok(Date.parse(session.expiresAt) > Date.now());
  } finally {
    closeTwitterOAuthSessions();
    if (previousClientId === undefined) delete process.env.TWITTER_CLIENT_ID;
    else process.env.TWITTER_CLIENT_ID = previousClientId;
    if (previousSecret === undefined) delete process.env.TWITTER_CLIENT_SECRET;
    else process.env.TWITTER_CLIENT_SECRET = previousSecret;
    if (previousCallback === undefined) delete process.env.TWITTER_OAUTH_CALLBACK_URL;
    else process.env.TWITTER_OAUTH_CALLBACK_URL = previousCallback;
  }
});
