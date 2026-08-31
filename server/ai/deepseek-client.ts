import { defaultDeepSeekModel, type DeepSeekModel } from "../../shared/types.js";
import { aiConfig, requiredSecret } from "../config.js";
import { fetchWithPolicy } from "../http-client.js";
import { AiError, type AiClient, type AiCompletion, type AiCompletionOptions, type AiMessage } from "./types.js";

type RequestFunction = typeof fetchWithPolicy;

interface DeepSeekResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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

      let response: Response;
      try {
        response = await request(
          config.endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: config.model,
              messages,
              thinking: { type: "enabled" },
              reasoning_effort: "high",
              response_format: { type: "json_object" },
              max_tokens: config.maxOutputTokens,
              stream: false
            }),
            signal: options.signal
          },
          {
            timeoutMs: config.timeoutMs,
            retries: options.transportRetries ?? 1,
            retryStatuses: (status) => status === 429 || status >= 500
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
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new AiError("invalid_response", "DeepSeek returned an empty response.");
      return {
        content,
        model: config.model,
        usage: {
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens
        }
      };
    }
  };
}
