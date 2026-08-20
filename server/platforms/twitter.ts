import type { Creator, CreatorCandidate } from "../../shared/types.js";
import { encryptCredential } from "../credentials.js";
import { fetchWithPolicy } from "../http-client.js";
import { replacePlatformAccountCredential } from "../repositories/platform.js";
import { activeTwitterCredential } from "../twitter-auth.js";
import { PlatformError, type CollectedContent, type PlatformAdapter, type PlatformAccountIdentity } from "./types.js";
import { imageValue, metadataText, numberValue, record, recordsDeep, stringValue, type JsonRecord } from "./web-page.js";

const apiBaseUrl = "https://api.x.com/2";
const webBaseUrl = "https://x.com";

function username(input: string) {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/(?:twitter|x)\.com\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)?.[1];
  const value = (fromUrl || trimmed).replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : "";
}

function userCandidate(object: JsonRecord): CreatorCandidate | undefined {
  const externalId = stringValue(object.id);
  const name = stringValue(object.name);
  const handle = stringValue(object.username);
  if (!/^\d+$/.test(externalId) || !name || !handle) return undefined;
  const metrics = record(object.public_metrics);
  return {
    platform: "twitter",
    externalId,
    name,
    handle: `@${handle}`,
    avatarUrl: imageValue(object.profile_image_url) || imageValue(object.profileImageUrl),
    profileUrl: `${webBaseUrl}/${encodeURIComponent(handle)}`,
    followerCount: numberValue(metrics?.followers_count, metrics?.followersCount)
  };
}

export function parseTwitterUsers(payload: unknown): CreatorCandidate[] {
  const output: CreatorCandidate[] = [];
  const seen = new Set<string>();
  for (const object of recordsDeep(payload)) {
    const candidate = userCandidate(object);
    if (!candidate || seen.has(candidate.externalId)) continue;
    seen.add(candidate.externalId);
    output.push(candidate);
  }
  return output;
}

function publicTwitterUsers(payload: unknown) {
  const protectedIds = new Set(recordsDeep(payload)
    .filter((object) => object.protected === true)
    .map((object) => stringValue(object.id))
    .filter(Boolean));
  return parseTwitterUsers(payload).filter((candidate) => !protectedIds.has(candidate.externalId));
}

interface TwitterPostRecord {
  id: string;
  text: string;
  createdAt: string;
  mediaKeys: string[];
  tags: string[];
  raw: JsonRecord;
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
}

function postText(object: JsonRecord) {
  const noteTweet = record(object.note_tweet);
  return stringValue(noteTweet?.text, object.text);
}

export function parseTwitterPosts(payload: unknown): TwitterPostRecord[] {
  const root = record(payload);
  const data = Array.isArray(root?.data) ? arrayRecords(root.data) : [];
  const output: TwitterPostRecord[] = [];
  const seen = new Set<string>();
  for (const object of data) {
    const id = stringValue(object.id);
    const text = postText(object);
    if (!/^\d+$/.test(id) || !text || seen.has(id)) continue;
    const entities = record(object.entities);
    const hashtags = arrayRecords(entities?.hashtags).map((item) => stringValue(item.tag)).filter(Boolean);
    const cashtags = arrayRecords(entities?.cashtags).map((item) => stringValue(item.tag)).filter(Boolean);
    const attachments = record(object.attachments);
    const mediaKeys = Array.isArray(attachments?.media_keys)
      ? attachments.media_keys.map((item) => stringValue(item)).filter(Boolean)
      : [];
    seen.add(id);
    output.push({
      id,
      text,
      createdAt: stringValue(object.created_at) || new Date().toISOString(),
      mediaKeys,
      tags: [...new Set([...hashtags, ...cashtags])].slice(0, 30),
      raw: object
    });
  }
  return output;
}

function twitterApiError(status: number, payload: unknown, fallback: string) {
  if (status === 401 || status === 403) {
    return new PlatformError("auth_required", "Twitter/X 授权无效或缺少读取权限，请重新授权绑定。");
  }
  if (status === 402) {
    return new PlatformError("rate_limited", "Twitter/X API 读取额度不足，请在开发者平台补充额度后重试。");
  }
  if (status === 429) return new PlatformError("rate_limited", "Twitter/X API 请求过于频繁，请稍后重试。");
  if (status === 404) return new PlatformError("creator_not_found", "没有找到该 Twitter/X 账号或内容。");
  const root = record(payload);
  const detail = stringValue(root?.detail, root?.title);
  return new PlatformError("platform_error", detail ? `${fallback}：${detail.slice(0, 300)}` : fallback);
}

async function twitterRequest(path: string, credential: string, signal?: AbortSignal) {
  const active = await activeTwitterCredential(credential, signal);
  if (active.refreshed) {
    replacePlatformAccountCredential("twitter", encryptCredential(active.credential));
  }
  const response = await fetchWithPolicy(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${active.accessToken}` },
    signal
  }, { timeoutMs: 12_000, retries: 1, retryStatuses: (status) => status >= 500 });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw twitterApiError(response.status, payload, "Twitter/X API 请求失败");
  return payload;
}

const userFields = "id,name,username,profile_image_url,protected,public_metrics";

async function userById(externalId: string, credential: string, signal?: AbortSignal) {
  if (!/^\d+$/.test(externalId)) throw new PlatformError("creator_not_found", "Twitter/X 账号 ID 格式不正确。");
  const payload = await twitterRequest(`/users/${encodeURIComponent(externalId)}?user.fields=${userFields}`, credential, signal);
  const candidate = publicTwitterUsers(payload)[0];
  if (!candidate) throw new PlatformError("creator_not_found", "没有找到该公开 Twitter/X 账号；受保护账号不支持采集。");
  return candidate;
}

async function userByUsername(handle: string, credential: string, signal?: AbortSignal) {
  const payload = await twitterRequest(`/users/by/username/${encodeURIComponent(handle)}?user.fields=${userFields}`, credential, signal);
  const candidate = publicTwitterUsers(payload)[0];
  if (!candidate) throw new PlatformError("creator_not_found", "没有找到该公开 Twitter/X 账号；受保护账号不支持采集。");
  return candidate;
}

async function checkAccount(credential: string, signal?: AbortSignal): Promise<PlatformAccountIdentity> {
  const payload = await twitterRequest(`/users/me?user.fields=${userFields}`, credential, signal);
  const candidate = parseTwitterUsers(payload)[0];
  if (!candidate) throw new PlatformError("platform_error", "无法读取当前 Twitter/X 账号，请重新授权绑定。");
  return {
    externalUserId: candidate.externalId,
    displayName: candidate.handle ? `${candidate.name} (${candidate.handle})` : candidate.name,
    avatarUrl: candidate.avatarUrl
  };
}

async function searchCreators(query: string, credential: string, signal?: AbortSignal) {
  const handle = username(query);
  if (handle) {
    try {
      return [await userByUsername(handle, credential, signal)];
    } catch (error) {
      if (error instanceof PlatformError && error.code === "creator_not_found" && !/^@|https?:/i.test(query.trim())) {
        // A plain word can also be a display-name search; fall through.
      } else {
        throw error;
      }
    }
  }
  const params = new URLSearchParams({ query: query.trim(), "user.fields": userFields, max_results: "10" });
  const payload = await twitterRequest(`/users/search?${params}`, credential, signal);
  return publicTwitterUsers(payload).slice(0, 8);
}

async function resolveCreator(externalId: string, credential: string, signal?: AbortSignal) {
  return userById(externalId, credential, signal);
}

function mediaMap(payload: unknown) {
  const root = record(payload);
  const includes = record(root?.includes);
  const media = arrayRecords(includes?.media);
  return new Map(media.map((item) => [stringValue(item.media_key), item] as const).filter(([key]) => Boolean(key)));
}

async function listCreatorContent(creator: Creator, credential: string, limit: number, signal?: AbortSignal): Promise<CollectedContent[]> {
  const params = new URLSearchParams({
    max_results: String(Math.max(5, Math.min(20, limit))),
    exclude: "retweets,replies",
    expansions: "attachments.media_keys",
    "tweet.fields": "id,text,created_at,entities,attachments,note_tweet",
    "media.fields": "media_key,type,url,preview_image_url,alt_text"
  });
  const payload = await twitterRequest(`/users/${encodeURIComponent(creator.externalId)}/tweets?${params}`, credential, signal);
  const posts = parseTwitterPosts(payload).slice(0, Math.max(1, limit));
  const media = mediaMap(payload);
  return posts.map((post) => {
    const assets = post.mediaKeys.map((key) => media.get(key)).filter((item): item is JsonRecord => Boolean(item));
    const coverUrl = assets.map((item) => imageValue(item.url) || imageValue(item.preview_image_url)).find(Boolean);
    const isVideo = assets.some((item) => ["video", "animated_gif"].includes(stringValue(item.type)));
    const title = post.text.split(/\r?\n/)[0]?.trim().slice(0, 300) || `Twitter/X 帖子 ${post.id}`;
    const hasBody = Boolean(post.text.trim());
    return {
      externalId: post.id,
      contentType: isVideo ? "video" : "note",
      title,
      description: post.text,
      tags: post.tags,
      sourceUrl: `${creator.profileUrl}/status/${post.id}`,
      coverUrl,
      publishedAt: post.createdAt,
      transcript: hasBody ? post.text : metadataText(title, "", post.tags),
      transcriptSource: hasBody ? "body" : "metadata",
      status: hasBody ? "ready" : "metadata_only",
      warning: hasBody ? undefined : "帖子正文不可用，仅使用元数据分析。"
    };
  });
}

export const twitterAdapter: PlatformAdapter = {
  platform: "twitter",
  checkAccount,
  searchCreators,
  resolveCreator,
  listCreatorContent
};
