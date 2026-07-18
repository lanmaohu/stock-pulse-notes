import crypto from "node:crypto";
import type { Creator, CreatorCandidate } from "../../shared/types.js";
import { PlatformError, type CollectedContent, type PlatformAdapter, type PlatformAccountIdentity } from "./types.js";

interface BilibiliEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface NavData {
  isLogin?: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  wbi_img?: { img_url?: string; sub_url?: string };
}

interface CreatorSearchItem {
  mid?: number;
  uname?: string;
  upic?: string;
  usign?: string;
  fans?: number;
}

interface SpaceVideoItem {
  aid?: number;
  bvid?: string;
  author?: string;
  title?: string;
  description?: string;
  created?: number;
  pic?: string;
}

interface VideoDetail {
  aid?: number;
  bvid?: string;
  cid?: number;
  title?: string;
  desc?: string;
  pic?: string;
  owner?: { mid?: number; name?: string };
  pubdate?: number;
  pages?: Array<{ cid?: number }>;
  tname?: string;
}

interface SubtitleItem {
  subtitle_url?: string;
}

const mixinKeyOrder = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12,
  38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52
];
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let wbiCache: { key: string; expiresAt: number } | null = null;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headers(credential: string) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Cookie: credential,
    Referer: "https://www.bilibili.com/",
    "User-Agent": userAgent
  };
}

function platformError(status: number, message = "") {
  if (status === 401 || status === 403 || message.includes("未登录")) {
    return new PlatformError("auth_required", "B 站登录状态已失效，请重新扫码绑定。");
  }
  if (status === 412 || status === 429 || message.includes("频繁") || message.includes("风控")) {
    return new PlatformError("rate_limited", "B 站暂时限制了请求，请稍后再试。");
  }
  return new PlatformError("platform_error", message || `B 站请求失败（${status}）。`);
}

async function bilibiliJson<T>(url: string, credential: string): Promise<T> {
  const response = await fetch(url, { headers: headers(credential) });
  if (!response.ok) {
    throw platformError(response.status);
  }
  const body = (await response.json()) as BilibiliEnvelope<T>;
  if (body.code !== 0 || body.data === undefined) {
    if (body.code === -101) {
      throw platformError(401, body.message);
    }
    if (body.code === -352 || body.code === -509) {
      throw platformError(412, body.message);
    }
    throw new PlatformError("platform_error", body.message || `B 站接口返回错误 ${body.code ?? "unknown"}。`);
  }
  return body.data;
}

function imageKey(url: string | undefined) {
  const match = url?.match(/\/([^/]+)\.[a-z0-9]+(?:$|\?)/i);
  return match?.[1] || "";
}

async function wbiKey(credential: string) {
  if (wbiCache && wbiCache.expiresAt > Date.now()) {
    return wbiCache.key;
  }
  const nav = await bilibiliJson<NavData>("https://api.bilibili.com/x/web-interface/nav", credential);
  const source = `${imageKey(nav.wbi_img?.img_url)}${imageKey(nav.wbi_img?.sub_url)}`;
  if (!source) {
    throw new PlatformError("platform_error", "无法获取 B 站请求签名。");
  }
  const key = mixinKeyOrder.map((index) => source[index] || "").join("").slice(0, 32);
  wbiCache = { key, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return key;
}

async function signedUrl(base: string, params: Record<string, string | number>, credential: string) {
  const key = await wbiKey(credential);
  const wts = Math.floor(Date.now() / 1000);
  const safeEntries = Object.entries({ ...params, wts })
    .map(([name, value]) => [name, String(value).replace(/[!'()*]/g, "")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const searchParams = new URLSearchParams();
  for (const [name, value] of safeEntries) searchParams.set(name, value);
  const query = searchParams.toString();
  const wRid = crypto.createHash("md5").update(`${query}${key}`).digest("hex");
  return `${base}?${query}&w_rid=${wRid}`;
}

export async function checkBilibiliAccount(credential: string): Promise<PlatformAccountIdentity> {
  const nav = await bilibiliJson<NavData>("https://api.bilibili.com/x/web-interface/nav", credential);
  if (!nav.isLogin || !nav.mid) {
    throw new PlatformError("auth_required", "B 站登录状态已失效，请重新扫码绑定。");
  }
  return {
    externalUserId: String(nav.mid),
    displayName: nav.uname || `用户 ${nav.mid}`,
    avatarUrl: nav.face
  };
}

async function resolveCreator(externalId: string, credential: string): Promise<CreatorCandidate> {
  const mid = externalId.trim();
  if (!/^\d+$/.test(mid)) {
    throw new PlatformError("creator_not_found", "B 站 UID 格式不正确。");
  }
  const url = await signedUrl("https://api.bilibili.com/x/space/wbi/acc/info", { mid }, credential);
  const data = await bilibiliJson<{ mid?: number; name?: string; face?: string }>(url, credential).catch((error) => {
    if (error instanceof PlatformError && error.code === "platform_error") {
      throw new PlatformError("creator_not_found", "没有找到这个 B 站博主。");
    }
    throw error;
  });
  if (!data.mid) {
    throw new PlatformError("creator_not_found", "没有找到这个 B 站博主。");
  }
  return {
    platform: "bilibili",
    externalId: String(data.mid),
    name: data.name || `UP ${data.mid}`,
    avatarUrl: data.face,
    profileUrl: `https://space.bilibili.com/${data.mid}`
  };
}

function creatorIdFromQuery(query: string) {
  const trimmed = query.trim();
  const urlMatch = trimmed.match(/(?:space\.bilibili\.com\/|bilibili\.com\/space\/)(\d+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

async function searchCreators(query: string, credential: string): Promise<CreatorCandidate[]> {
  const exactId = creatorIdFromQuery(query);
  if (exactId) {
    return [await resolveCreator(exactId, credential)];
  }
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.searchParams.set("search_type", "bili_user");
  url.searchParams.set("keyword", query.trim());
  const data = await bilibiliJson<{ result?: CreatorSearchItem[] }>(url.toString(), credential);
  return (data.result || [])
    .filter((item) => item.mid && item.uname)
    .slice(0, 8)
    .map((item) => ({
      platform: "bilibili" as const,
      externalId: String(item.mid),
      name: item.uname!,
      avatarUrl: item.upic?.startsWith("//") ? `https:${item.upic}` : item.upic,
      profileUrl: `https://space.bilibili.com/${item.mid}`,
      followerCount: item.fans
    }));
}

async function creatorVideos(mid: string, limit: number, credential: string) {
  const url = await signedUrl(
    "https://api.bilibili.com/x/space/wbi/arc/search",
    { mid, pn: 1, ps: limit, order: "pubdate" },
    credential
  );
  const data = await bilibiliJson<{ list?: { vlist?: SpaceVideoItem[] } }>(url, credential);
  return (data.list?.vlist || []).filter((item) => item.bvid).slice(0, limit);
}

async function videoDetail(bvid: string, credential: string) {
  const url = new URL("https://api.bilibili.com/x/web-interface/view");
  url.searchParams.set("bvid", bvid);
  return bilibiliJson<VideoDetail>(url.toString(), credential);
}

async function subtitleText(bvid: string, cid: string, credential: string) {
  const url = await signedUrl("https://api.bilibili.com/x/player/wbi/v2", { bvid, cid }, credential);
  const data = await bilibiliJson<{ subtitle?: { subtitles?: SubtitleItem[] } }>(url, credential);
  const rawUrl = data.subtitle?.subtitles?.find((item) => item.subtitle_url)?.subtitle_url;
  if (!rawUrl) {
    return "";
  }
  const subtitleUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  const response = await fetch(subtitleUrl, { headers: headers(credential) });
  if (!response.ok) {
    throw new PlatformError("transcript_unavailable", `字幕读取失败（${response.status}）。`);
  }
  const body = (await response.json()) as { body?: Array<{ content?: string }> };
  return (body.body || [])
    .map((item) => item.content?.trim())
    .filter(Boolean)
    .join("\n");
}

function metadataTranscript(detail: VideoDetail, tags: string[]) {
  return [
    `标题: ${detail.title || ""}`,
    `简介: ${detail.desc || ""}`,
    `分区/标签: ${[detail.tname, ...tags].filter(Boolean).join(", ")}`
  ]
    .join("\n")
    .trim();
}

async function collectVideo(item: SpaceVideoItem, credential: string): Promise<CollectedContent> {
  const bvid = item.bvid!;
  const detail = await videoDetail(bvid, credential);
  const cid = String(detail.cid || detail.pages?.[0]?.cid || "");
  const tags = [detail.tname || ""].filter(Boolean);
  let transcript = "";
  let warning = "";
  if (cid) {
    try {
      transcript = await subtitleText(bvid, cid, credential);
    } catch (error) {
      warning = error instanceof Error ? error.message : "字幕读取失败。";
    }
  }
  if (!transcript) {
    transcript = metadataTranscript(detail, tags);
  }
  return {
    externalId: bvid,
    contentType: "video",
    title: detail.title || item.title || bvid,
    description: detail.desc || item.description || "",
    tags,
    sourceUrl: `https://www.bilibili.com/video/${bvid}`,
    coverUrl: detail.pic || item.pic,
    publishedAt: new Date((detail.pubdate || item.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    transcript,
    transcriptSource: transcript && !transcript.startsWith("标题:") ? "subtitle" : "metadata",
    status: transcript && !transcript.startsWith("标题:") ? "ready" : "metadata_only",
    warning
  };
}

async function listCreatorContent(creator: Creator, credential: string, limit: number) {
  const items = await creatorVideos(creator.externalId, limit, credential);
  const content: CollectedContent[] = [];
  for (const item of items) {
    content.push(await collectVideo(item, credential));
    if (items.length > 1) {
      await sleep(450);
    }
  }
  return content;
}

export const bilibiliAdapter: PlatformAdapter = {
  platform: "bilibili",
  checkAccount: checkBilibiliAccount,
  searchCreators,
  resolveCreator,
  listCreatorContent
};
