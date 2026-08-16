export type AiErrorCode =
  | "configuration"
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "upstream"
  | "invalid_response"
  | "aborted";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface AiMessage {
  role: "system" | "user";
  content: string;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface AiCompletion {
  content: string;
  model: string;
  usage: AiUsage;
}

export interface AiCompletionOptions {
  signal?: AbortSignal;
  transportRetries?: number;
}

export interface AiClient {
  readonly model: string;
  completeJson(messages: AiMessage[], options?: AiCompletionOptions): Promise<AiCompletion>;
}
