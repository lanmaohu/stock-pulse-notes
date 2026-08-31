import type { ContentItem, ContentStockView, ContentSummarySection, DeepSeekModel } from "../../shared/types.js";
import type { ContentAnalysisResult, ContentStockViewInput } from "../repositories/content.js";
import { createDeepSeekClient } from "./deepseek-client.js";
import { AiError, type AiClient, type AiMessage } from "./types.js";
import { log as writeLog, type LogLevel } from "../observability/logger.js";

interface ContentAiPayload {
  summarySections: unknown[];
  views: unknown[];
}

export interface ContentAnalysisOptions {
  client?: AiClient;
  model?: DeepSeekModel;
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
  sourceSnippet: 1_000,
  summarySections: 5,
  summaryHeading: 80,
  summaryBody: 1_200,
  summaryQuote: 500
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
  return transcriptSource === "metadata" ? "low" : "medium";
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
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("summarySections" in parsed) ||
    !Array.isArray(parsed.summarySections) ||
    !("views" in parsed) ||
    !Array.isArray(parsed.views)
  ) {
    throw new AiError("invalid_response", "AI response did not match the expected schema.");
  }
  return {
    summarySections: parsed.summarySections.slice(0, limits.summarySections),
    views: parsed.views.slice(0, limits.views)
  };
}

function promptFor(content: ContentItem): AiMessage[] {
  const summaryInstruction = content.transcriptSource === "subtitle"
    ? `同时把字幕按原有叙述顺序总结为 3 至 5 个章节；字幕很短或信息不足时可以少于 3 个，但至少返回 1 个。每个章节必须包含简短小标题、一个自然段和 1 至 2 条能直接支持该段内容的字幕原句。sourceQuotes 必须逐字复制字幕中的连续原文，不得改写、拼接、使用省略号或补充字幕没有表达的信息。`
    : "本内容不是真实视频字幕，summarySections 必须返回空数组。";
  return [
    {
      role: "system",
      content: "你是一个严谨的内容总结与投资观点提取助手。只能使用用户提供的标题、简介、正文、字幕或元数据，不得引入外部知识、背景事实、推测、建议或材料之外的因果关系。标的可以是股票代码、上市公司、行业板块或产业主题。不要给买入、卖出或仓位指令。必须返回严格 JSON。"
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

正文、字幕或元数据:
${content.transcript.slice(0, limits.transcript)}

${summaryInstruction}

同时提取内容里的核心标的观点。没有明确股票代码时，也要提取明确出现的上市公司、行业板块或产业主题；只有完全没有投资相关内容时才返回空 views。只返回以下结构的严格 JSON:
{
  "summarySections": [{
    "heading": string, "body": string, "sourceQuotes": string[]
  }],
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

function normalizedQuoteText(value: string) {
  return value.replace(/\s+/gu, "").trim();
}

function normalizeSummarySections(payload: ContentAiPayload, content: ContentItem): ContentSummarySection[] {
  if (content.transcriptSource !== "subtitle") return [];
  const transcript = normalizedQuoteText(content.transcript.slice(0, limits.transcript));
  const sections = payload.summarySections.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new AiError("invalid_response", "AI response contained an invalid summary section.");
    }
    const section = candidate as Record<string, unknown>;
    const heading = stringValue(section.heading, limits.summaryHeading);
    const body = stringValue(section.body, limits.summaryBody);
    if (!heading || !body || !Array.isArray(section.sourceQuotes)) {
      throw new AiError("invalid_response", "AI response contained an incomplete summary section.");
    }
    const sourceQuotes = section.sourceQuotes
      .map((quote) => stringValue(quote, limits.summaryQuote))
      .filter(Boolean)
      .slice(0, 2);
    if (!sourceQuotes.length || sourceQuotes.some((quote) => !transcript.includes(normalizedQuoteText(quote)))) {
      throw new AiError("invalid_response", "AI summary evidence did not match the transcript.");
    }
    return { heading, body, sourceQuotes };
  });
  if (!sections.length) throw new AiError("invalid_response", "AI response did not contain a transcript summary.");
  return sections;
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

function logEntry(log: ContentAnalysisOptions["log"], entry: Record<string, unknown>) {
  if (log) {
    log(entry);
    return;
  }
  const { level, event, ...fields } = entry;
  writeLog((level as LogLevel) || "info", typeof event === "string" ? event : "content_analysis", fields);
}

export async function analyzeContent(
  content: ContentItem,
  options: ContentAnalysisOptions = {}
): Promise<ContentAnalysisResult> {
  if (!content.transcript.trim()) return { summarySections: [], views: [] };
  const client = options.client || createDeepSeekClient(options.model);
  const startedAt = performance.now();
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  try {
    const completion = await client.completeJson(promptFor(content), { signal: options.signal, transportRetries: 0 });
    promptTokens = completion.usage.promptTokens;
    completionTokens = completion.usage.completionTokens;
    const payload = parsePayload(completion.content);
    const summarySections = normalizeSummarySections(payload, content);
    const views = normalizeViews(payload, content, client.model);

    const normalizedViews = views.length || content.transcriptSource !== "metadata"
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
    const result = { summarySections, views: normalizedViews };
    logEntry(options.log, {
      level: "info",
      event: "content_analysis_completed",
      contentId: content.id,
      model: client.model,
      transcriptSource: content.transcriptSource,
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens,
      completionTokens,
      summarySectionCount: result.summarySections.length,
      viewCount: result.views.length
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
      promptTokens,
      completionTokens,
      code: aiError.code
    });
    throw aiError;
  }
}
