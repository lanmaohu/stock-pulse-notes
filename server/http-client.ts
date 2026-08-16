export interface FetchPolicy {
  timeoutMs?: number;
  retries?: number;
  retryStatuses?: (status: number) => boolean;
}
function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  policy: FetchPolicy = {}
) {
  const timeoutMs = policy.timeoutMs ?? 12_000;
  const retries = policy.retries ?? 1;
  const retryStatuses = policy.retryStatuses ?? ((status: number) => status >= 500);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (attempt < retries && retryStatuses(response.status)) {
        await response.body?.cancel();
        await wait(500 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw error;
      await wait(500 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}
