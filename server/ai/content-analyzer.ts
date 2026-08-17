import type { ContentItem, ContentStockView } from "../../shared/types.js";
import type { ContentStockViewInput } from "../repositories/content.js";
import { createDeepSeekClient } from "./deepseek-client.js";
import { AiError, type AiClient, type AiMessage, type AiUsage } from "./types.js";
import { log as writeLog, type LogLevel } from "../observability/logger.js";

interface ContentAiPayload {
  views: unknown[];
}

export interface ContentAnalysisOptions {
  client?: AiClient;
  signal?: AbortSignal;
  log?: (entry: Record<string, unknown>) => void;
}

const limits = {
  description: 5_000,
  transcript: 80_000,
  views: 12,
  list: 8,
  listItem: 500,
  coreView: 2_000,
  sourceSnippet: 1_000
} as const;

function stringValue(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, limits.listItem))
        .filter(Boolean)
        .slice(0, limits.list)
    : [];
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

function parsePayload(content: string): ContentAiPayload {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new AiError("invalid_response", "AI response did not contain JSON.");
    try {
      parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      throw new AiError("invalid_response", "AI response contained malformed JSON.");
    }
  }
  if (!parsed || typeof parsed !== "object" || !("views" in parsed) || !Array.isArray(parsed.views)) {
    throw new AiError("invalid_response", "AI response did not match the expected schema.");
  }
  return { views: parsed.views.slice(0, limits.views) };
}

function promptFor(content: ContentItem): AiMessage[] {
  return [
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
${content.description.slice(0, limits.description) || "无"}

字幕或元数据:
${content.transcript.slice(0, limits.transcript)}

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
  ];
}

function repairPrompt(content: string): AiMessage[] {
  return [
    {
      role: "system",
      content: "修复下面的模型输出，使其成为符合指定结构的严格 JSON。不要新增原输出中没有的事实，只返回 JSON 对象。"
    },
    {
      role: "user",
      content: `目标结构: {"views":[{"symbols":string[],"companies":string[],"stance":"bullish|bearish|neutral|mixed|watch","coreView":string,"evidence":string[],"risks":string[],"confidence":"high|medium|low","sourceSnippet":string}]}

待修复输出:
${content.slice(0, 24_000)}`
    }
  ];
}

function normalizeViews(payload: ContentAiPayload, content: ContentItem, model: string): ContentStockViewInput[] {
  return payload.views.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new AiError("invalid_response", "AI response contained an invalid view.");
    }
    const view = candidate as Record<string, unknown>;
    const coreView = stringValue(view.coreView, limits.coreView);
    if (!coreView) throw new AiError("invalid_response", "AI response contained a view without coreView.");
    return [{
      symbols: stringList(view.symbols),
      companies: stringList(view.companies),
      stance: normalizeStance(view.stance),
      coreView,
      evidence: stringList(view.evidence),
      risks: stringList(view.risks),
      confidence: normalizeConfidence(view.confidence, content.transcriptSource),
      sourceSnippet: stringValue(view.sourceSnippet, limits.sourceSnippet),
      model
    }];
  });
}

function mergeUsage(left: AiUsage, right: AiUsage): AiUsage {
  return {
    promptTokens: (left.promptTokens || 0) + (right.promptTokens || 0) || undefined,
    completionTokens: (left.completionTokens || 0) + (right.completionTokens || 0) || undefined
  };
}

function logEntry(log: ContentAnalysisOptions["log"], entry: Record<string, unknown>) {
  if (log) {
    log(entry);
    return;
  }
  const { level, event, ...fields } = entry;
  writeLog((level as LogLevel) || "info", typeof event === "string" ? event : "content_analysis", fields);
}

export async function analyzeContentStockViews(
  content: ContentItem,
  options: ContentAnalysisOptions = {}
): Promise<ContentStockViewInput[]> {
  if (!content.transcript.trim()) return [];
  const client = options.client || createDeepSeekClient();
  const startedAt = performance.now();
  let usage: AiUsage = {};
  let repaired = false;
  try {
    const completion = await client.completeJson(promptFor(content), { signal: options.signal, transportRetries: 1 });
    usage = completion.usage;
    let views: ContentStockViewInput[];
    try {
      views = normalizeViews(parsePayload(completion.content), content, client.model);
    } catch (error) {
      if (!(error instanceof AiError && error.code === "invalid_response")) throw error;
      repaired = true;
      const repair = await client.completeJson(repairPrompt(completion.content), {
        signal: options.signal,
        transportRetries: 0
      });
      usage = mergeUsage(usage, repair.usage);
      views = normalizeViews(parsePayload(repair.content), content, client.model);
    }

    const result = views.length || content.transcriptSource === "subtitle"
      ? views
      : [{
          symbols: [],
          companies: stringList([content.title.replace(/^[-+\d.万，,\s]+/, "").slice(0, 24)]),
          stance: "watch" as const,
          coreView: `视频元数据提到：${content.title}`.slice(0, limits.coreView),
          evidence: [content.description ? content.description.slice(0, 180) : content.title],
          risks: ["当前视频未获取到字幕，仅基于标题、简介和标签提取，信息完整度较低。"],
          confidence: "low" as const,
          sourceSnippet: [content.title, content.description, content.tags.join(" ")].join("\n").trim().slice(0, 300),
          model: client.model
        }];
    logEntry(options.log, {
      level: "info",
      event: "content_analysis_completed",
      contentId: content.id,
      model: client.model,
      transcriptSource: content.transcriptSource,
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      viewCount: result.length,
      repaired
    });
    return result;
  } catch (error) {
    const aiError = error instanceof AiError
      ? error
      : new AiError("invalid_response", error instanceof Error ? error.message : "AI analysis failed.");
    logEntry(options.log, {
      level: aiError.code === "aborted" ? "info" : "error",
      event: "content_analysis_failed",
      contentId: content.id,
      model: client.model,
      transcriptSource: content.transcriptSource,
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      code: aiError.code
    });
    throw aiError;
  }
}
