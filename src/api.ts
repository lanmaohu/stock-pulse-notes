type UnauthorizedHandler = (() => void) | null;
let unauthorizedHandler: UnauthorizedHandler = null;

const protectedPrefixes = [
  "/api/platform-accounts",
  "/api/creators",
  "/api/collection-runs",
  "/api/collection-settings",
  "/api/content-items",
  "/api/portfolio"
];

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public requestId?: string
  ) {
    super(message);
  }
}
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string; requestId?: string };
    if (response.status === 401 && protectedPrefixes.some((prefix) => path.startsWith(prefix))) {
      unauthorizedHandler?.();
    }
    throw new ApiError(body.error || "请求失败。", response.status, body.code, body.requestId);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
