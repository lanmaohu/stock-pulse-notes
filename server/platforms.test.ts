import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrowserCredential } from "./platforms/browser.js";
import { parseDouyinAwemes, parseDouyinUsers } from "./platforms/douyin.js";
import { parseXiaohongshuNotes, parseXiaohongshuUsers } from "./platforms/xiaohongshu.js";

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
