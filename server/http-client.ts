export interface FetchPolicy {
  timeoutMs?: number;
  retries?: number;
  retryStatuses?: (status: number) => boolean;
}
function wait(milliseconds: number, signal?: AbortSignal | null) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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
    const externalSignal = init.signal;
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    try {
      const response = await fetch(input, { ...init, signal });
      if (attempt < retries && retryStatuses(response.status)) {
        await response.body?.cancel();
        await wait(500 * (attempt + 1), externalSignal);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted) throw error;
      if (attempt >= retries) throw error;
      await wait(500 * (attempt + 1), externalSignal);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}
