import crypto from "node:crypto";
import type { Creator, CreatorCandidate } from "../../shared/types.js";
import { fetchWithPolicy } from "../http-client.js";
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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
let wbiCache: { key: string; expiresAt: number } | null = null;

const bilibiliRequestIntervalMs = 1_500;
const bilibiliRequestJitterMs = 750;
const bilibiliRateLimitRetryDelaysMs = [8_000, 20_000];
const bilibiliRateLimitFinalCooldownMs = 60_000;

function sleep(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
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

interface BilibiliRequestClientOptions {
  fetcher?: typeof fetchWithPolicy;
  wait?: typeof sleep;
  now?: () => number;
  random?: () => number;
  minIntervalMs?: number;
  jitterMs?: number;
  retryDelaysMs?: number[];
  finalCooldownMs?: number;
}

export function createBilibiliRequestClient(options: BilibiliRequestClientOptions = {}) {
  const fetcher = options.fetcher || fetchWithPolicy;
  const wait = options.wait || sleep;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const minIntervalMs = options.minIntervalMs ?? bilibiliRequestIntervalMs;
  const jitterMs = options.jitterMs ?? bilibiliRequestJitterMs;
  const retryDelaysMs = options.retryDelaysMs || bilibiliRateLimitRetryDelaysMs;
  const finalCooldownMs = options.finalCooldownMs ?? bilibiliRateLimitFinalCooldownMs;
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  const cooldown = (milliseconds: number) => {
    nextRequestAt = Math.max(nextRequestAt, now() + milliseconds);
  };

  const waitForTurn = async (signal?: AbortSignal) => {
    const turn = queue.then(async () => {
      const remaining = Math.max(0, nextRequestAt - now());
      if (remaining) await wait(remaining, signal);
      const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
      nextRequestAt = now() + minIntervalMs + jitter;
    });
    queue = turn.catch(() => undefined);
    await turn;
  };

  const retryOrThrow = (error: PlatformError, attempt: number) => {
    if (error.code !== "rate_limited") throw error;
    const retryDelay = retryDelaysMs[attempt];
    cooldown(retryDelay ?? finalCooldownMs);
    if (retryDelay === undefined) throw error;
  };

  async function requestJson<T>(url: string, credential: string, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await waitForTurn(signal);
      const response = await fetcher(
        url,
        { headers: headers(credential), signal },
        { timeoutMs: 12_000, retries: 1 }
      );
      if (!response.ok) {
        const error = platformError(response.status);
        if (error.code === "rate_limited") await response.body?.cancel();
        retryOrThrow(error, attempt);
        continue;
      }
      const body = (await response.json()) as BilibiliEnvelope<T>;
      if (body.code === 0 && body.data !== undefined) return body.data;
      const error = body.code === -101
        ? platformError(401, body.message)
        : body.code === -352 || body.code === -509
          ? platformError(412, body.message)
          : new PlatformError("platform_error", body.message || `B 站接口返回错误 ${body.code ?? "unknown"}。`);
      retryOrThrow(error, attempt);
    }
  }

  return { requestJson };
}

const bilibiliRequestClient = createBilibiliRequestClient();

async function bilibiliJson<T>(url: string, credential: string, signal?: AbortSignal): Promise<T> {
  return bilibiliRequestClient.requestJson<T>(url, credential, signal);
}

function imageKey(url: string | undefined) {
  const match = url?.match(/\/([^/]+)\.[a-z0-9]+(?:$|\?)/i);
  return match?.[1] || "";
}

async function wbiKey(credential: string, signal?: AbortSignal) {
  if (wbiCache && wbiCache.expiresAt > Date.now()) {
    return wbiCache.key;
  }
  const nav = await bilibiliJson<NavData>("https://api.bilibili.com/x/web-interface/nav", credential, signal);
  const source = `${imageKey(nav.wbi_img?.img_url)}${imageKey(nav.wbi_img?.sub_url)}`;
  if (!source) {
    throw new PlatformError("platform_error", "无法获取 B 站请求签名。");
  }
  const key = mixinKeyOrder.map((index) => source[index] || "").join("").slice(0, 32);
  wbiCache = { key, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return key;
}

async function signedUrl(base: string, params: Record<string, string | number>, credential: string, signal?: AbortSignal) {
  const key = await wbiKey(credential, signal);
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

export async function checkBilibiliAccount(credential: string, signal?: AbortSignal): Promise<PlatformAccountIdentity> {
  const nav = await bilibiliJson<NavData>("https://api.bilibili.com/x/web-interface/nav", credential, signal);
  if (!nav.isLogin || !nav.mid) {
    throw new PlatformError("auth_required", "B 站登录状态已失效，请重新扫码绑定。");
  }
  return {
    externalUserId: String(nav.mid),
    displayName: nav.uname || `用户 ${nav.mid}`,
    avatarUrl: nav.face
  };
}

async function resolveCreator(externalId: string, credential: string, signal?: AbortSignal): Promise<CreatorCandidate> {
  const mid = externalId.trim();
  if (!/^\d+$/.test(mid)) {
    throw new PlatformError("creator_not_found", "B 站 UID 格式不正确。");
  }
  const url = await signedUrl("https://api.bilibili.com/x/space/wbi/acc/info", { mid }, credential, signal);
  const data = await bilibiliJson<{ mid?: number; name?: string; face?: string }>(url, credential, signal).catch((error) => {
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

async function searchCreators(query: string, credential: string, signal?: AbortSignal): Promise<CreatorCandidate[]> {
  const exactId = creatorIdFromQuery(query);
  if (exactId) {
    return [await resolveCreator(exactId, credential, signal)];
  }
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.searchParams.set("search_type", "bili_user");
  url.searchParams.set("keyword", query.trim());
  const data = await bilibiliJson<{ result?: CreatorSearchItem[] }>(url.toString(), credential, signal);
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

async function creatorVideos(mid: string, limit: number, credential: string, signal?: AbortSignal) {
  const url = await signedUrl(
    "https://api.bilibili.com/x/space/wbi/arc/search",
    { mid, pn: 1, ps: limit, order: "pubdate" },
    credential,
    signal
  );
  const data = await bilibiliJson<{ list?: { vlist?: SpaceVideoItem[] } }>(url, credential, signal);
  return (data.list?.vlist || []).filter((item) => item.bvid).slice(0, limit);
}

async function videoDetail(bvid: string, credential: string, signal?: AbortSignal) {
  const url = new URL("https://api.bilibili.com/x/web-interface/view");
  url.searchParams.set("bvid", bvid);
  return bilibiliJson<VideoDetail>(url.toString(), credential, signal);
}

async function subtitleText(bvid: string, cid: string, credential: string, signal?: AbortSignal) {
  const url = await signedUrl("https://api.bilibili.com/x/player/wbi/v2", { bvid, cid }, credential, signal);
  const data = await bilibiliJson<{ subtitle?: { subtitles?: SubtitleItem[] } }>(url, credential, signal);
  const rawUrl = data.subtitle?.subtitles?.find((item) => item.subtitle_url)?.subtitle_url;
  if (!rawUrl) {
    return "";
  }
  const subtitleUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  const response = await fetchWithPolicy(subtitleUrl, { headers: headers(credential), signal }, { timeoutMs: 12_000, retries: 1 });
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

async function collectVideo(item: SpaceVideoItem, credential: string, signal?: AbortSignal): Promise<CollectedContent> {
  const bvid = item.bvid!;
  const detail = await videoDetail(bvid, credential, signal);
  const cid = String(detail.cid || detail.pages?.[0]?.cid || "");
  const tags = [detail.tname || ""].filter(Boolean);
  let transcript = "";
  let warning = "";
  if (cid) {
    try {
      transcript = await subtitleText(bvid, cid, credential, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
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

async function listCreatorContent(creator: Creator, credential: string, limit: number, signal?: AbortSignal) {
  const items = await creatorVideos(creator.externalId, limit, credential, signal);
  const content: CollectedContent[] = [];
  for (const item of items) {
    content.push(await collectVideo(item, credential, signal));
    if (items.length > 1) {
      await sleep(450, signal);
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
