import type { BilibiliVideo, ChatMessage, ContentItem, ContentStockView, Note, VideoStockView } from "../shared/types.js";
import {
  type ContentStockViewInput,
  createAiRun,
  finishAiRun,
  getDailyContext,
  getSummaryByDate,
  saveDailySummary,
  type VideoStockViewInput,
  type SuggestionInput,
  type SummaryInput
} from "./db.js";

interface AiPayload {
  coreViews?: string[];
  insights?: string[];
  investmentThemes?: string[];
  evidence?: string[];
  risks?: string[];
  questions?: string[];
  nextSteps?: string[];
  researchSuggestions?: SuggestionInput[];
}

interface VideoAiPayload {
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

const disclaimer = "以下内容仅用于个人投研复盘和学习，不构成买卖建议、收益承诺或个性化投资顾问服务。";

function env(name: string) {
  return process.env[name] || "";
}

function list(value: unknown, fallback: string[] = []) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12) : fallback;
}

function compactMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => `[${message.messageAt}] ${message.sender}: ${message.content}`)
    .join("\n")
    .slice(0, 60000);
}

function compactNotes(notes: Note[]) {
  return notes
    .map((note) => `# ${note.title}\n标签: ${note.tags.join(", ") || "无"}\n${note.content}`)
    .join("\n\n")
    .slice(0, 40000);
}

function compactVideoViews(views: VideoStockView[]) {
  return views
    .map(
      (view) =>
        `[${view.publishedAt}] ${view.creatorName}《${view.title}》\n标的: ${[...view.symbols, ...view.companies].join(", ") || "未识别"}\n观点: ${view.coreView}\n依据: ${view.evidence.join("；")}\n风险: ${view.risks.join("；")}`
    )
    .join("\n\n")
    .slice(0, 50000);
}

function extractJson<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("AI response did not contain JSON.");
    }
    return JSON.parse(match[0]) as T;
  }
}

async function deepSeekChat<T>(messages: Array<{ role: "system" | "user"; content: string }>) {
  const apiKey = env("DEEPSEEK_API_KEY");
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured.");
  }
  const model = env("AI_MODEL") || "deepseek-v4-pro";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: false
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${text.slice(0, 400)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek response is empty.");
  }
  return { payload: extractJson<T>(content), usage: body.usage, model };
}

async function callDeepSeek(date: string, messages: ChatMessage[], notes: Note[], videoViews: VideoStockView[]) {
  return deepSeekChat<AiPayload>([
    {
      role: "system",
      content:
        "你是一个严谨的个人量化投资研究助手。只基于用户提供的聊天记录、笔记和公开视频观点做复盘，输出研究观点、风险和待验证清单。不要给确定性收益承诺，不要输出直接买入/卖出/仓位指令。必须返回 JSON。"
    },
    {
      role: "user",
      content: `日期: ${date}

聊天记录:
${compactMessages(messages) || "无"}

当日笔记:
${compactNotes(notes) || "无"}

B 站视频观点:
${compactVideoViews(videoViews) || "无"}

请返回严格 JSON，字段为:
{
  "coreViews": string[],
  "insights": string[],
  "investmentThemes": string[],
  "evidence": string[],
  "risks": string[],
  "questions": string[],
  "nextSteps": string[],
  "researchSuggestions": [
    {
      "title": string,
      "thesis": string,
      "rationale": string,
      "risks": string[],
      "validationSteps": string[]
    }
  ]
}`
    }
  ]);
}

function fallbackPayload(date: string, messages: ChatMessage[], notes: Note[], videoViews: VideoStockView[] = []): AiPayload {
  return {
    coreViews: [`${date} 共归档 ${messages.length} 条聊天、${notes.length} 条笔记、${videoViews.length} 条视频观点。`],
    insights: ["未配置大模型或模型调用失败时，可先将原始材料归档，等待手动重新总结。"],
    investmentThemes: [],
    evidence: [
      ...messages.slice(0, 3).map((message) => `${message.sender}: ${message.content.slice(0, 120)}`),
      ...videoViews.slice(0, 3).map((view) => `${view.creatorName}: ${view.coreView.slice(0, 120)}`)
    ],
    risks: ["缺少外部行情、财报和持仓数据，不能把聊天观点直接视为投资结论。"],
    questions: ["哪些观点需要用数据回测或基本面材料验证？"],
    nextSteps: ["补充关键标的、时间区间、假设和反例，再触发 AI 总结。"],
    researchSuggestions: []
  };
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
  if (!content.transcript.trim()) {
    return [];
  }
  const result = await deepSeekChat<VideoAiPayload>([
    {
      role: "system",
      content:
        "你是一个严谨的投资视频观点提取助手。只基于用户提供的视频标题、简介、字幕或元数据提取投资相关观点。标的可以是股票代码、上市公司、行业板块或产业主题。不要给买入/卖出/仓位指令，不要补充材料之外的事实。必须返回 JSON。"
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
  "views": [
    {
      "symbols": string[],
      "companies": string[],
      "stance": "bullish" | "bearish" | "neutral" | "mixed" | "watch",
      "coreView": string,
      "evidence": string[],
      "risks": string[],
      "confidence": "high" | "medium" | "low",
      "sourceSnippet": string
    }
  ]
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
  if (views.length || content.transcriptSource === "subtitle") {
    return views;
  }
  const text = [content.title, content.description, content.tags.join(" ")].join("\n").trim();
  if (!text) {
    return [];
  }
  return [
    {
      symbols: [],
      companies: stringList([content.title.replace(/^[-+\d.万，,\s]+/, "").slice(0, 24)]),
      stance: "watch",
      coreView: `视频元数据提到：${content.title}`,
      evidence: [content.description ? content.description.slice(0, 180) : content.title],
      risks: ["当前视频未获取到字幕，仅基于标题、简介和标签提取，信息完整度较低。"],
      confidence: "low",
      sourceSnippet: text.slice(0, 300),
      model: `${result.model}:metadata-fallback`
    }
  ];
}

export async function analyzeVideoStockViews(video: BilibiliVideo): Promise<VideoStockViewInput[]> {
  return analyzeContentStockViews({
    id: video.id,
    platform: "bilibili",
    externalId: video.bvid,
    creatorId: video.creatorMid,
    creatorExternalId: video.creatorMid,
    creatorName: video.creatorName,
    contentType: "video",
    title: video.title,
    description: video.description,
    tags: video.tags,
    sourceUrl: video.videoUrl,
    publishedAt: video.publishedAt,
    collectedAt: video.collectedAt,
    transcript: video.transcript,
    transcriptSource: video.transcriptSource,
    status: video.status === "pending" ? "metadata_only" : video.status,
    analysisStatus: video.summaryStatus === "success" ? "success" : video.summaryStatus,
    error: video.error,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt
  });
}

export async function summarizeDate(date: string, options: { regenerate?: boolean; fallback?: boolean } = {}) {
  const existing = getSummaryByDate(date);
  if (existing && !options.regenerate) {
    return existing;
  }

  const provider = env("AI_PROVIDER") || "deepseek";
  const model = env("AI_MODEL") || "deepseek-v4-pro";
  const runId = createAiRun(date, provider, model);
  const context = getDailyContext(date);

  try {
    const result =
      provider === "deepseek"
        ? await callDeepSeek(date, context.messages, context.notes, context.videoViews)
        : { payload: fallbackPayload(date, context.messages, context.notes, context.videoViews), usage: undefined, model };

    const payload = result.payload;
    const summary: SummaryInput = {
      date,
      coreViews: list(payload.coreViews, [`${date} 暂无核心观点。`]),
      insights: list(payload.insights),
      investmentThemes: list(payload.investmentThemes),
      evidence: list(payload.evidence),
      risks: list(payload.risks, ["研究内容仅供复盘，需要独立验证。"]),
      questions: list(payload.questions),
      nextSteps: list(payload.nextSteps),
      disclaimer,
      sourceMessageCount: context.messages.length,
      sourceNoteCount: context.notes.length,
      sourceVideoViewCount: context.videoViews.length,
      model: result.model
    };
    const suggestions = Array.isArray(payload.researchSuggestions) ? payload.researchSuggestions : [];
    const saved = saveDailySummary(summary, suggestions, Boolean(options.regenerate));
    finishAiRun(runId, "success", undefined, {
      prompt: result.usage?.prompt_tokens,
      completion: result.usage?.completion_tokens
    });
    return saved;
  } catch (error) {
    finishAiRun(runId, "error", error instanceof Error ? error.message : "Unknown AI error.");
    if (options.fallback) {
      const payload = fallbackPayload(date, context.messages, context.notes, context.videoViews);
      return saveDailySummary(
        {
          date,
          coreViews: list(payload.coreViews),
          insights: list(payload.insights),
          investmentThemes: list(payload.investmentThemes),
          evidence: list(payload.evidence),
          risks: list(payload.risks),
          questions: list(payload.questions),
          nextSteps: list(payload.nextSteps),
          disclaimer,
          sourceMessageCount: context.messages.length,
          sourceNoteCount: context.notes.length,
          sourceVideoViewCount: context.videoViews.length,
          model: "fallback"
        },
        [],
        Boolean(options.regenerate)
      );
    }
    throw error;
  }
}
