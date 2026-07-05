import type { ChatMessage, Note } from "../shared/types.js";
import {
  createAiRun,
  finishAiRun,
  getDailyContext,
  getSummaryByDate,
  saveDailySummary,
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

function extractJson(content: string): AiPayload {
  try {
    return JSON.parse(content) as AiPayload;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("AI response did not contain JSON.");
    }
    return JSON.parse(match[0]) as AiPayload;
  }
}

async function callDeepSeek(date: string, messages: ChatMessage[], notes: Note[]) {
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
      messages: [
        {
          role: "system",
          content:
            "你是一个严谨的个人量化投资研究助手。只基于用户提供的聊天记录和笔记做复盘，输出研究观点、风险和待验证清单。不要给确定性收益承诺，不要输出直接买入/卖出/仓位指令。必须返回 JSON。"
        },
        {
          role: "user",
          content: `日期: ${date}

聊天记录:
${compactMessages(messages) || "无"}

当日笔记:
${compactNotes(notes) || "无"}

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
      ],
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
  return { payload: extractJson(content), usage: body.usage, model };
}

function fallbackPayload(date: string, messages: ChatMessage[], notes: Note[]): AiPayload {
  return {
    coreViews: [`${date} 共归档 ${messages.length} 条聊天、${notes.length} 条笔记。`],
    insights: ["未配置大模型或模型调用失败时，可先将原始材料归档，等待手动重新总结。"],
    investmentThemes: [],
    evidence: messages.slice(0, 5).map((message) => `${message.sender}: ${message.content.slice(0, 120)}`),
    risks: ["缺少外部行情、财报和持仓数据，不能把聊天观点直接视为投资结论。"],
    questions: ["哪些观点需要用数据回测或基本面材料验证？"],
    nextSteps: ["补充关键标的、时间区间、假设和反例，再触发 AI 总结。"],
    researchSuggestions: []
  };
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
        ? await callDeepSeek(date, context.messages, context.notes)
        : { payload: fallbackPayload(date, context.messages, context.notes), usage: undefined, model };

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
      const payload = fallbackPayload(date, context.messages, context.notes);
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
          model: "fallback"
        },
        [],
        Boolean(options.regenerate)
      );
    }
    throw error;
  }
}
