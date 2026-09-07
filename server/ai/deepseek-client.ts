import crypto from "node:crypto";
import { defaultDeepSeekModel, type DeepSeekModel } from "../../shared/types.js";
import { aiConfig, requiredSecret } from "../config.js";
import { fetchWithPolicy } from "../http-client.js";
import { log } from "../observability/logger.js";
import { AiError, type AiClient, type AiCompletion, type AiCompletionOptions, type AiMessage } from "./types.js";

type RequestFunction = typeof fetchWithPolicy;

interface DeepSeekResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function retryMessages(messages: AiMessage[]) {
  const copy = messages.map((message) => ({ ...message }));
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    if (copy[index]?.role !== "user") continue;
    copy[index]!.content += "\n\n上一次生成结果为空。请立即输出一个非空、可被 JSON.parse 解析的 JSON 对象；不要输出 Markdown 代码块或任何 JSON 之外的文字。";
    break;
  }
  return copy;
}

function addUsage(current: number | undefined, next: number | undefined) {
  if (current === undefined && next === undefined) return undefined;
  return (current || 0) + (next || 0);
}

function responseError(status: number) {
  if (status === 401 || status === 403) {
    return new AiError("authentication", "DeepSeek authentication failed.", status);
  }
  if (status === 429) {
    return new AiError("rate_limited", "DeepSeek rate limit exceeded.", status);
  }
  if (status >= 400 && status < 500) {
    return new AiError("configuration", `DeepSeek rejected the request (${status}).`, status);
  }
  return new AiError("upstream", `DeepSeek request failed (${status}).`, status);
}

function requestFailure(error: unknown, signal?: AbortSignal) {
  if (error instanceof AiError) return error;
  if (signal?.aborted) return new AiError("aborted", "DeepSeek request was cancelled.");
  if (error instanceof Error && error.name === "AbortError") {
    return new AiError("timeout", "DeepSeek request timed out.");
  }
  return new AiError("upstream", "DeepSeek request could not be completed.");
}

export function createDeepSeekClient(
  model: DeepSeekModel = defaultDeepSeekModel,
  request: RequestFunction = fetchWithPolicy
): AiClient {
  const config = aiConfig(model);
  return {
    model: config.model,
    async completeJson(messages: AiMessage[], options: AiCompletionOptions = {}): Promise<AiCompletion> {
      let apiKey: string;
      try {
        apiKey = requiredSecret("DEEPSEEK_API_KEY");
      } catch {
        throw new AiError("configuration", "DEEPSEEK_API_KEY is not configured.");
      }

      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      const completionId = crypto.randomUUID();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (options.signal?.aborted) throw new AiError("aborted", "DeepSeek request was cancelled.");
          const fallback = attempt === 1;
          let response: Response;
          try {
            response = await request(
              config.endpoint,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: config.model,
                  messages: fallback ? retryMessages(messages) : messages,
                  thinking: { type: "disabled" },
                  response_format: { type: fallback ? "text" : "json_object" },
                  max_tokens: config.maxOutputTokens,
                  stream: false
                }),
                signal: options.signal
              },
              {
                timeoutMs: config.timeoutMs,
                retries: options.transportRetries ?? 1,
                retryStatuses: (status) => status === 429 || status >= 500,
                onAttempt: (transportAttempt) => log("info", "deepseek_request_started", {
                  completionId, contentId: options.contentId, model: config.model, attempt, transportAttempt
                })
              }
            );
          } catch (error) {
            throw requestFailure(error, options.signal);
          }
          if (!response.ok) throw responseError(response.status);

          let body: DeepSeekResponse;
          try {
            body = (await response.json()) as DeepSeekResponse;
          } catch {
            throw new AiError("invalid_response", "DeepSeek returned invalid JSON.");
          }
          promptTokens = addUsage(promptTokens, body.usage?.prompt_tokens);
          completionTokens = addUsage(completionTokens, body.usage?.completion_tokens);
          log("info", "deepseek_response_usage", {
            completionId, contentId: options.contentId, model: config.model, attempt,
            promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens,
            usageAvailable: body.usage?.prompt_tokens !== undefined && body.usage?.completion_tokens !== undefined
          });
          const choice = body.choices?.[0];
          const content = choice?.message?.content;
          const truncated = choice?.finish_reason === "length";
          if (content?.trim() && !truncated) {
            return {
              content,
              model: config.model,
              usage: { promptTokens, completionTokens }
            };
          }
          if (!fallback) {
            log("warn", "deepseek_response_retry", {
              model: config.model,
              reason: truncated ? "truncated" : "empty",
              finishReason: choice?.finish_reason || "unknown",
              reasoningContentLength: choice?.message?.reasoning_content?.length || 0,
              promptTokens: body.usage?.prompt_tokens,
              completionTokens: body.usage?.completion_tokens
            });
            continue;
          }
          if (truncated) {
            throw new AiError("invalid_response", "DeepSeek response was truncated after one retry.");
          }
        }
        throw new AiError("invalid_response", "DeepSeek returned an empty response after one retry.");
      } catch (error) {
        const failure = requestFailure(error, options.signal);
        throw new AiError(failure.code, failure.message, failure.status, { promptTokens, completionTokens });
      }
    }
  };
}
