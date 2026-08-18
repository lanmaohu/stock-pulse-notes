import type { Page } from "playwright-core";
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

const baseUrl = "https://www.xiaohongshu.com";

function profileId(input: string) {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/xiaohongshu\.com\/user\/profile\/([^/?#]+)/i)?.[1];
  if (fromUrl) return decodeURIComponent(fromUrl);
  return /^[A-Za-z0-9_-]{16,80}$/.test(trimmed) ? trimmed : "";
}

function avatar(object: JsonRecord) {
  return imageValue(object.image) || imageValue(object.avatar) || imageValue(object.images) || imageValue(object.avatar_url);
}

export function parseXiaohongshuUsers(payload: unknown): CreatorCandidate[] {
  const seen = new Set<string>();
  const candidates: CreatorCandidate[] = [];
  for (const object of recordsDeep(payload)) {
    const externalId = stringValue(object.user_id, object.userId, object.userid);
    const name = stringValue(object.nickname, object.nick_name, object.nickName);
    if (!externalId || !name || seen.has(externalId)) continue;
    seen.add(externalId);
    candidates.push({
      platform: "xiaohongshu",
      externalId,
      name,
      handle: stringValue(object.red_id, object.redId, object.xhs_id) || undefined,
      avatarUrl: avatar(object),
      profileUrl: `${baseUrl}/user/profile/${encodeURIComponent(externalId)}`,
      followerCount: numberValue(object.fans, object.fans_count, object.follower_count)
    });
  }
  return candidates;
}

function noteId(object: JsonRecord) {
  return stringValue(object.note_id, object.noteId, object.id);
}

export interface XiaohongshuNoteRecord {
  id: string;
  xsecToken?: string;
  raw: JsonRecord;
}

export function parseXiaohongshuNotes(payload: unknown): XiaohongshuNoteRecord[] {
  const seen = new Set<string>();
  const notes: XiaohongshuNoteRecord[] = [];
  for (const object of recordsDeep(payload)) {
    const id = noteId(object);
    const hasNoteShape = object.note_card || object.noteCard || object.display_title || object.title || object.desc || object.type;
    if (!id || !hasNoteShape || seen.has(id) || !/^[a-fA-F0-9]{16,40}$/.test(id)) continue;
    seen.add(id);
    notes.push({
      id,
      xsecToken: stringValue(object.xsec_token, object.xsecToken) || undefined,
      raw: record(object.note_card) || record(object.noteCard) || object
    });
  }
  return notes;
}

function noteTags(object: JsonRecord) {
  const result: string[] = [];
  for (const list of [object.tag_list, object.tagList, object.tags]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = record(item);
      const value = entry ? stringValue(entry.name, entry.title) : stringValue(item);
      if (value && !result.includes(value)) result.push(value);
    }
  }
  return result.slice(0, 30);
}

function noteCover(object: JsonRecord) {
  return imageValue(object.cover) || imageValue(object.image_list) || imageValue(object.imageList) || imageValue(object.images);
}

function noteBody(object: JsonRecord) {
  return stringValue(object.desc, object.description, object.content);
}

function noteTitle(object: JsonRecord, id: string) {
  const body = noteBody(object);
  return stringValue(object.title, object.display_title, object.displayTitle, body.split(/\r?\n/)[0]?.slice(0, 300), `小红书笔记 ${id}`);
}

function noteType(object: JsonRecord) {
  const type = stringValue(object.type, object.note_type, object.noteType).toLowerCase();
  return type.includes("video") || object.video ? "video" as const : "note" as const;
}

async function cookiesLoggedIn(page: Page) {
  const cookies = await page.context().cookies(baseUrl);
  return cookies.some((cookie) => cookie.name === "web_session" && cookie.value);
}

async function currentProfileId(page: Page) {
  const links = await page.locator("a[href*='/user/profile/']").evaluateAll((elements) => elements.map((element) => {
    const node = element as unknown as {
      getAttribute(name: string): string | null;
      textContent?: string | null;
      closest(selector: string): unknown;
    };
    return {
      href: node.getAttribute("href") || "",
      text: node.textContent?.trim() || "",
      inNavigation: Boolean(node.closest("header, nav, [class*='sidebar'], [class*='user-info']"))
    };
  })).catch(() => []);
  const ordered = [
    ...links.filter((link) => link.text === "我"),
    ...links.filter((link) => link.inNavigation),
    ...links
  ];
  for (const link of ordered) {
    const externalId = profileId(link.href);
    if (externalId) return externalId;
  }
  return "";
}

async function resolveOnPage(page: Page, externalId: string) {
  const payloads = await capturePageJson(page, async () => {
    await page.goto(`${baseUrl}/user/profile/${encodeURIComponent(externalId)}`, { waitUntil: "domcontentloaded" });
  }, (url) => /user_posted|otherinfo|profile/i.test(url));
  await assertUsablePage(page, "小红书");
  const candidates = parseXiaohongshuUsers(payloads);
  const candidate = candidates.find((item) => item.externalId === externalId) || candidates[0];
  if (candidate) return candidate;
  const name = stringValue(
    await page.locator("h1").first().textContent().catch(() => ""),
    await page.locator(".user-name, .username, [class*='user-name']").first().textContent().catch(() => "")
  );
  if (!name) throw new PlatformError("creator_not_found", "没有找到该小红书博主。");
  return { platform: "xiaohongshu", externalId, name, profileUrl: `${baseUrl}/user/profile/${encodeURIComponent(externalId)}` } satisfies CreatorCandidate;
}

async function checkAccount(credential: string, signal?: AbortSignal): Promise<PlatformAccountIdentity> {
  return withPlatformBrowser("xiaohongshu", credential, async ({ page }) => {
    if (!await cookiesLoggedIn(page)) throw new PlatformError("auth_required", "小红书登录状态已失效，请重新扫码绑定。");
    const payloads = await capturePageJson(page, async () => {
      await page.goto(`${baseUrl}/explore`, { waitUntil: "domcontentloaded" });
    }, (url) => /\/user\/(?:selfinfo|me)|otherinfo/i.test(url), 1_200);
    await assertUsablePage(page, "小红书");
    const self = parseXiaohongshuUsers(payloads)[0];
    if (self) return { externalUserId: self.externalId, displayName: self.name, avatarUrl: self.avatarUrl };
    const externalId = await currentProfileId(page);
    if (!externalId) throw new PlatformError("platform_error", "无法读取当前小红书账号，请重新扫码绑定。");
    const candidate = await resolveOnPage(page, externalId);
    return { externalUserId: candidate.externalId, displayName: candidate.name, avatarUrl: candidate.avatarUrl };
  }, signal);
}

async function searchCreators(query: string, credential: string, signal?: AbortSignal) {
  return withPlatformBrowser("xiaohongshu", credential, async ({ page }) => {
    const direct = profileId(query);
    if (direct) return [await resolveOnPage(page, direct)];
    const payloads = await capturePageJson(page, async () => {
      await page.goto(`${baseUrl}/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes&type=55`, { waitUntil: "domcontentloaded" });
    }, (url) => /search.*user|usersearch|search\/notes/i.test(url));
    await assertUsablePage(page, "小红书");
    return parseXiaohongshuUsers(payloads).slice(0, 8);
  }, signal);
}

async function resolveCreator(externalId: string, credential: string, signal?: AbortSignal) {
  return withPlatformBrowser("xiaohongshu", credential, ({ page }) => resolveOnPage(page, externalId), signal);
}

function noteUrl(note: XiaohongshuNoteRecord) {
  const params = new URLSearchParams({ xsec_source: "pc_user" });
  if (note.xsecToken) params.set("xsec_token", note.xsecToken);
  return `${baseUrl}/explore/${note.id}?${params}`;
}

async function noteDetail(page: Page, note: XiaohongshuNoteRecord) {
  const payloads = await capturePageJson(page, async () => {
    await page.goto(noteUrl(note), { waitUntil: "domcontentloaded" });
  }, (url) => /\/feed|note\/detail/i.test(url), 1_400);
  await assertUsablePage(page, "小红书");
  return parseXiaohongshuNotes(payloads).find((item) => item.id === note.id)?.raw || note.raw;
}

async function listCreatorContent(creator: Creator, credential: string, limit: number, signal?: AbortSignal): Promise<CollectedContent[]> {
  return withPlatformBrowser("xiaohongshu", credential, async ({ page }) => {
    const payloads = await capturePageJson(page, async () => {
      await page.goto(creator.profileUrl, { waitUntil: "domcontentloaded" });
      await page.mouse.wheel(0, 900).catch(() => undefined);
    }, (url) => /user_posted|\/feed/i.test(url), 2_200);
    await assertUsablePage(page, "小红书");
    const notes = parseXiaohongshuNotes(payloads).slice(0, Math.max(1, limit));
    if (!notes.length) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (/暂无笔记|还没有发布|没有发布过/.test(body)) return [];
      throw new PlatformError("platform_error", "未能读取小红书笔记列表，平台页面结构可能已变化。");
    }
    const output: CollectedContent[] = [];
    for (const note of notes) {
      const detail = await noteDetail(page, note).catch((error) => {
        if (error instanceof PlatformError && (error.code === "auth_required" || error.code === "rate_limited")) throw error;
        return note.raw;
      });
      const title = noteTitle(detail, note.id);
      const description = noteBody(detail);
      const tags = noteTags(detail);
      const hasBody = Boolean(description.trim());
      output.push({
        externalId: note.id,
        contentType: noteType(detail),
        title,
        description,
        tags,
        sourceUrl: noteUrl(note),
        coverUrl: noteCover(detail),
        publishedAt: isoDate(detail.time ?? detail.create_time ?? detail.createTime ?? detail.last_update_time),
        transcript: hasBody ? [title, description].filter(Boolean).join("\n\n") : metadataText(title, description, tags),
        transcriptSource: hasBody ? "body" : "metadata",
        status: hasBody ? "ready" : "metadata_only",
        warning: hasBody ? undefined : "笔记正文不可用，仅使用标题和标签分析。"
      });
      if (notes.length > 1) await page.waitForTimeout(650);
    }
    return output;
  }, signal, 120_000);
}

export const xiaohongshuAdapter: PlatformAdapter = {
  platform: "xiaohongshu",
  checkAccount,
  searchCreators,
  resolveCreator,
  listCreatorContent
};
