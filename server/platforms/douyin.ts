import type { BrowserContext, Page } from "playwright-core";
import type { Creator, CreatorCandidate } from "../../shared/types.js";
import { withPlatformBrowser } from "./browser.js";
import { PlatformError, type CollectedContent, type PlatformAdapter, type PlatformAccountIdentity } from "./types.js";
import {
  assertUsablePage,
  capturePageJson,
  imageValue,
  isoDate,
  metadataText,
  numberValue,
  record,
  recordsDeep,
  stringValue,
  type JsonRecord
} from "./web-page.js";

const baseUrl = "https://www.douyin.com";

function profileId(input: string) {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/douyin\.com\/user\/([^/?#]+)/i)?.[1];
  if (fromUrl) return decodeURIComponent(fromUrl);
  return /^MS4wLjAB[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : "";
}

function avatar(object: JsonRecord) {
  return imageValue(object.avatar_thumb) || imageValue(object.avatarThumb) || imageValue(object.avatar_medium) || imageValue(object.avatar);
}

export function parseDouyinUsers(payload: unknown): CreatorCandidate[] {
  const seen = new Set<string>();
  const candidates: CreatorCandidate[] = [];
  for (const object of recordsDeep(payload)) {
    const externalId = stringValue(object.sec_uid, object.secUid);
    const name = stringValue(object.nickname, object.nick_name, object.name);
    if (!externalId || !name || seen.has(externalId)) continue;
    seen.add(externalId);
    candidates.push({
      platform: "douyin",
      externalId,
      name,
      handle: stringValue(object.unique_id, object.uniqueId, object.short_id) || undefined,
      avatarUrl: avatar(object),
      profileUrl: `${baseUrl}/user/${encodeURIComponent(externalId)}`,
      followerCount: numberValue(object.follower_count, object.followerCount)
    });
  }
  return candidates;
}

function awemeId(object: JsonRecord) {
  return stringValue(object.aweme_id, object.awemeId);
}

export function parseDouyinAwemes(payload: unknown) {
  const seen = new Set<string>();
  const output: JsonRecord[] = [];
  for (const object of recordsDeep(payload)) {
    const id = awemeId(object);
    if (!id || seen.has(id)) continue;
    if (!object.video && !object.images && !object.image_post_info && !object.desc) continue;
    seen.add(id);
    output.push(object);
  }
  return output;
}

function tags(object: JsonRecord) {
  const values: string[] = [];
  const extras = Array.isArray(object.text_extra) ? object.text_extra : Array.isArray(object.textExtra) ? object.textExtra : [];
  for (const item of extras) {
    const entry = record(item);
    const value = entry ? stringValue(entry.hashtag_name, entry.hashtagName) : "";
    if (value && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 30);
}

function authorId(object: JsonRecord) {
  const author = record(object.author);
  return author ? stringValue(author.sec_uid, author.secUid) : "";
}

function cover(object: JsonRecord) {
  const video = record(object.video);
  return imageValue(video?.cover) || imageValue(video?.origin_cover) || imageValue(video?.dynamic_cover) || imageValue(object.cover);
}

function captionUrls(object: JsonRecord) {
  const urls: string[] = [];
  for (const candidate of recordsDeep([object.caption_infos, object.captionInfos, record(object.video)?.caption_infos])) {
    const url = stringValue(candidate.url, candidate.caption_url, candidate.captionUrl);
    if (/^https?:\/\//.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, 3);
}

function captionText(payload: unknown) {
  const lines: string[] = [];
  for (const object of recordsDeep(payload)) {
    const value = stringValue(object.text, object.content, object.utterance);
    if (value && value.length < 2_000 && !lines.includes(value)) lines.push(value);
  }
  return lines.join("\n").slice(0, 120_000);
}

async function fetchCaption(context: BrowserContext, object: JsonRecord) {
  for (const url of captionUrls(object)) {
    try {
      const response = await context.request.get(url, { timeout: 10_000 });
      if (!response.ok()) continue;
      const text = await response.text();
      if (!text.trim()) continue;
      try {
        const parsed = captionText(JSON.parse(text));
        if (parsed) return parsed;
      } catch {
        const cleaned = text.replace(/^WEBVTT.*$/gm, "").replace(/^\d\d?:\d\d(?::\d\d)?[.,]\d+\s+-->.*$/gm, "").trim();
        if (cleaned) return cleaned.slice(0, 120_000);
      }
    } catch {
      // Caption availability is optional; metadata remains usable.
    }
  }
  return "";
}

async function cookiesLoggedIn(page: Page) {
  const cookies = await page.context().cookies(baseUrl);
  return cookies.some((cookie) => ["sessionid", "sessionid_ss", "sid_guard", "passport_auth_status"].includes(cookie.name) && cookie.value);
}

async function currentProfileId(page: Page) {
  const selectors = [
    "a[data-e2e='user-avatar']",
    "[data-e2e='user-avatar']",
    "a[data-e2e='nav-user-avatar']",
    "header a[href*='/user/']",
    "nav a[href*='/user/']",
    "a[href*='/user/']"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const href = await locator.getAttribute("href").catch(() => null)
      || await locator.locator("xpath=ancestor-or-self::a[1]").getAttribute("href").catch(() => null);
    const externalId = href ? profileId(href) : "";
    if (externalId) return externalId;
  }
  return "";
}

async function resolveOnPage(page: Page, externalId: string) {
  const payloads = await capturePageJson(page, async () => {
    await page.goto(`${baseUrl}/user/${encodeURIComponent(externalId)}`, { waitUntil: "domcontentloaded" });
  }, (url) => /user\/profile|aweme\/post|query\/user/i.test(url));
  await assertUsablePage(page, "抖音");
  const candidates = parseDouyinUsers(payloads);
  const candidate = candidates.find((item) => item.externalId === externalId) || candidates[0];
  if (candidate) return candidate;
  const name = stringValue(
    await page.locator("h1").first().textContent().catch(() => ""),
    await page.locator("[data-e2e='user-title']").first().textContent().catch(() => "")
  );
  if (!name) throw new PlatformError("creator_not_found", "没有找到该抖音博主。");
  return { platform: "douyin", externalId, name, profileUrl: `${baseUrl}/user/${encodeURIComponent(externalId)}` } satisfies CreatorCandidate;
}

async function checkAccount(credential: string, signal?: AbortSignal): Promise<PlatformAccountIdentity> {
  return withPlatformBrowser("douyin", credential, async ({ page }) => {
    if (!await cookiesLoggedIn(page)) throw new PlatformError("auth_required", "抖音登录状态已失效，请重新扫码绑定。");
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await assertUsablePage(page, "抖音");
    const externalId = await currentProfileId(page);
    if (!externalId) throw new PlatformError("platform_error", "无法读取当前抖音账号，请重新扫码绑定。");
    const candidate = await resolveOnPage(page, externalId);
    return { externalUserId: candidate.externalId, displayName: candidate.name, avatarUrl: candidate.avatarUrl };
  }, signal);
}

async function searchCreators(query: string, credential: string, signal?: AbortSignal) {
  return withPlatformBrowser("douyin", credential, async ({ page }) => {
    const direct = profileId(query);
    if (direct) return [await resolveOnPage(page, direct)];
    const payloads = await capturePageJson(page, async () => {
      await page.goto(`${baseUrl}/search/${encodeURIComponent(query)}?type=user`, { waitUntil: "domcontentloaded" });
    }, (url) => /search|discover/i.test(url));
    await assertUsablePage(page, "抖音");
    return parseDouyinUsers(payloads).slice(0, 8);
  }, signal);
}

async function resolveCreator(externalId: string, credential: string, signal?: AbortSignal) {
  return withPlatformBrowser("douyin", credential, ({ page }) => resolveOnPage(page, externalId), signal);
}

async function listCreatorContent(creator: Creator, credential: string, limit: number, signal?: AbortSignal): Promise<CollectedContent[]> {
  return withPlatformBrowser("douyin", credential, async ({ page, context }) => {
    const payloads = await capturePageJson(page, async () => {
      await page.goto(creator.profileUrl, { waitUntil: "domcontentloaded" });
      await page.mouse.wheel(0, 900).catch(() => undefined);
    }, (url) => /aweme\/post|aweme\/detail/i.test(url), 2_300);
    await assertUsablePage(page, "抖音");
    let awemes = parseDouyinAwemes(payloads);
    const matching = awemes.filter((object) => !authorId(object) || authorId(object) === creator.externalId);
    if (matching.length) awemes = matching;
    if (!awemes.length) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (/暂无作品|还没有发布|没有发布过/.test(body)) return [];
      throw new PlatformError("platform_error", "未能读取抖音作品列表，平台页面结构可能已变化。");
    }
    const output: CollectedContent[] = [];
    for (const object of awemes.slice(0, Math.max(1, limit))) {
      const id = awemeId(object);
      const description = stringValue(object.desc, object.description);
      const itemTags = tags(object);
      const title = description.split(/\r?\n/)[0]?.trim().slice(0, 300) || `抖音作品 ${id}`;
      const subtitle = await fetchCaption(context, object);
      const imagePost = Array.isArray(object.images) || Boolean(object.image_post_info);
      output.push({
        externalId: id,
        contentType: imagePost ? "note" : "video",
        title,
        description,
        tags: itemTags,
        sourceUrl: `${baseUrl}/${imagePost ? "note" : "video"}/${id}`,
        coverUrl: cover(object),
        publishedAt: isoDate(object.create_time ?? object.createTime),
        transcript: subtitle || metadataText(title, description, itemTags),
        transcriptSource: subtitle ? "subtitle" : "metadata",
        status: subtitle ? "ready" : "metadata_only",
        warning: subtitle ? undefined : "平台未提供可读取的字幕，仅使用标题、描述和标签分析。"
      });
    }
    return output;
  }, signal, 120_000);
}

export const douyinAdapter: PlatformAdapter = {
  platform: "douyin",
  checkAccount,
  searchCreators,
  resolveCreator,
  listCreatorContent
};
