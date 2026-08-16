import type { ContentItem, ContentStockView } from "../shared/types.js";
import { fetchWithPolicy } from "./http-client.js";
import type { ContentStockViewInput } from "./repositories/content.js";

interface ContentAiPayload {
  views?: Array<{
    symbols?: string[];
    companies?: string[];
    stance?: ContentStockView["stance"];
    coreView?: string;
    evidence?: string[];
    risks?: string[];
    confidence?: ContentStockView["confidence"];
    sourceSnippet?: string;
  }>;
}
function extractJson<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response did not contain JSON.");
    return JSON.parse(match[0]) as T;
  }
}

async function deepSeekChat<T>(messages: Array<{ role: "system" | "user"; content: string }>) {
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured.");
  const model = process.env.AI_MODEL || "deepseek-v4-pro";
  const response = await fetchWithPolicy("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, thinking: { type: "enabled" }, reasoning_effort: "high", stream: false })
  }, { timeoutMs: 90_000, retries: 1, retryStatuses: (status) => status === 429 || status >= 500 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${text.slice(0, 400)}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek response is empty.");
  return { payload: extractJson<T>(content), model };
}

function stringList(value: unknown, limit = 8) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function normalizeStance(value: unknown): ContentStockView["stance"] {
  return value === "bullish" || value === "bearish" || value === "neutral" || value === "mixed" || value === "watch"
    ? value
    : "watch";
}

function normalizeConfidence(value: unknown, transcriptSource: ContentItem["transcriptSource"]): ContentStockView["confidence"] {
  if (value === "high" || value === "medium" || value === "low") {
    return transcriptSource === "metadata" && value === "high" ? "medium" : value;
  }
  return transcriptSource === "subtitle" ? "medium" : "low";
}

export async function analyzeContentStockViews(content: ContentItem): Promise<ContentStockViewInput[]> {
  if (!content.transcript.trim()) return [];
  const result = await deepSeekChat<ContentAiPayload>([
    {
      role: "system",
      content: "你是一个严谨的投资视频观点提取助手。只基于用户提供的视频标题、简介、字幕或元数据提取投资相关观点。标的可以是股票代码、上市公司、行业板块或产业主题。不要给买入/卖出/仓位指令，不要补充材料之外的事实。必须返回 JSON。"
    },
    {
      role: "user",
      content: `内容平台: ${content.platform}
博主: ${content.creatorName}
标题: ${content.title}
链接: ${content.sourceUrl}
文本来源: ${content.transcriptSource}
简介:
${content.description.slice(0, 5000) || "无"}

字幕或元数据:
${content.transcript.slice(0, 80000)}

请提取视频里的核心标的观点。没有明确股票代码时，也要提取明确出现的上市公司、行业板块或产业主题；只有完全没有投资相关内容时才返回空 views。严格 JSON:
{
  "views": [{
    "symbols": string[], "companies": string[],
    "stance": "bullish" | "bearish" | "neutral" | "mixed" | "watch",
    "coreView": string, "evidence": string[], "risks": string[],
    "confidence": "high" | "medium" | "low", "sourceSnippet": string
  }]
}`
    }
  ]);

  const views = (Array.isArray(result.payload.views) ? result.payload.views : [])
    .filter((view) => typeof view.coreView === "string" && view.coreView.trim())
    .map((view) => ({
      symbols: stringList(view.symbols),
      companies: stringList(view.companies),
      stance: normalizeStance(view.stance),
      coreView: view.coreView!.trim(),
      evidence: stringList(view.evidence),
      risks: stringList(view.risks),
      confidence: normalizeConfidence(view.confidence, content.transcriptSource),
      sourceSnippet: typeof view.sourceSnippet === "string" ? view.sourceSnippet.trim() : "",
      model: result.model
    }));
  if (views.length || content.transcriptSource === "subtitle") return views;
  const text = [content.title, content.description, content.tags.join(" ")].join("\n").trim();
  if (!text) return [];
  return [{
    symbols: [],
    companies: stringList([content.title.replace(/^[-+\d.万，,\s]+/, "").slice(0, 24)]),
    stance: "watch",
    coreView: `视频元数据提到：${content.title}`,
    evidence: [content.description ? content.description.slice(0, 180) : content.title],
    risks: ["当前视频未获取到字幕，仅基于标题、简介和标签提取，信息完整度较低。"],
    confidence: "low",
    sourceSnippet: text.slice(0, 300),
    model: `${result.model}:metadata-fallback`
  }];
}
