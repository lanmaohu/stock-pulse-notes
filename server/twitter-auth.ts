import crypto from "node:crypto";
import type { PlatformOAuthStartResponse } from "../shared/types.js";
import { twitterOAuthConfig } from "./config.js";
import { fetchWithPolicy } from "./http-client.js";
import { PlatformError } from "./platforms/types.js";

export interface TwitterCredentialEnvelope {
  version: 1;
  platform: "twitter";
  accessToken: string;
  refreshToken?: string;
  tokenType: "bearer";
  scopes: string[];
  expiresAt: string;
}

interface TwitterOAuthState {
  codeVerifier: string;
  expiresAt: number;
}

interface TokenPayload {
  token_type?: unknown;
  expires_in?: unknown;
  access_token?: unknown;
  scope?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const oauthStates = new Map<string, TwitterOAuthState>();
const authorizationEndpoint = "https://x.com/i/oauth2/authorize";
const tokenEndpoint = "https://api.x.com/2/oauth2/token";
const scopes = ["tweet.read", "users.read", "offline.access"] as const;

function base64Url(input: Buffer) {
  return input.toString("base64url");
}

function pruneOAuthStates(now = Date.now()) {
  for (const [state, session] of oauthStates) {
    if (session.expiresAt <= now) oauthStates.delete(state);
  }
}

function credentialFromToken(payload: TokenPayload, previous?: TwitterCredentialEnvelope): TwitterCredentialEnvelope {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new PlatformError("platform_error", "Twitter/X 未返回有效的访问凭据，请重新授权。");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? Math.max(60, payload.expires_in)
    : 7_200;
  const scope = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : previous?.scopes || [...scopes];
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token
    ? payload.refresh_token
    : previous?.refreshToken;
  if (!scope.includes("tweet.read") || !scope.includes("users.read")) {
    throw new PlatformError("auth_required", "Twitter/X 未授予账号与帖子读取权限，请重新授权。");
  }
  return {
    version: 1,
    platform: "twitter",
    accessToken,
    refreshToken,
    tokenType: "bearer",
    scopes: scope,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString()
  };
}

async function tokenRequest(parameters: URLSearchParams, purpose: "authorization" | "refresh", signal?: AbortSignal) {
  const config = twitterOAuthConfig();
  parameters.set("client_id", config.clientId);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }
  const response = await fetchWithPolicy(tokenEndpoint, {
    method: "POST",
    headers,
    body: parameters,
    signal
  }, { timeoutMs: 12_000, retries: 0 });
  const payload = await response.json().catch(() => ({})) as TokenPayload;
  if (!response.ok) {
    if (purpose === "refresh" && (response.status === 400 || response.status === 401)) {
      throw new PlatformError("auth_required", "Twitter/X 授权已失效，请重新授权绑定。");
    }
    if (response.status === 429) throw new PlatformError("rate_limited", "Twitter/X 授权请求过于频繁，请稍后重试。");
    throw new PlatformError("platform_error", "Twitter/X 授权失败，请检查开发者应用配置后重试。");
  }
  return payload;
}

export function parseTwitterCredential(credential: string): TwitterCredentialEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new PlatformError("auth_required", "Twitter/X 登录凭据已损坏，请重新授权绑定。");
  }
  const candidate = parsed as Partial<TwitterCredentialEnvelope> | null;
  if (
    !candidate || candidate.version !== 1 || candidate.platform !== "twitter" ||
    typeof candidate.accessToken !== "string" || !candidate.accessToken ||
    candidate.tokenType !== "bearer" || !Array.isArray(candidate.scopes) || !candidate.scopes.every((scope) => typeof scope === "string") ||
    typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    (candidate.refreshToken !== undefined && typeof candidate.refreshToken !== "string")
  ) {
    throw new PlatformError("auth_required", "Twitter/X 登录凭据格式无效，请重新授权绑定。");
  }
  return candidate as TwitterCredentialEnvelope;
}

export function createTwitterOAuthSession(): PlatformOAuthStartResponse {
  const config = twitterOAuthConfig();
  pruneOAuthStates();
  const state = base64Url(crypto.randomBytes(32));
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const expiresAt = Date.now() + 10 * 60 * 1_000;
  oauthStates.set(state, { codeVerifier, expiresAt });
  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  }).toString();
  return { platform: "twitter", authorizeUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
}

export async function completeTwitterOAuthSession(state: string, code: string, signal?: AbortSignal) {
  pruneOAuthStates();
  const session = oauthStates.get(state);
  oauthStates.delete(state);
  if (!session || session.expiresAt <= Date.now()) {
    throw new PlatformError("auth_required", "Twitter/X 授权会话已过期，请返回后台重新授权。");
  }
  const config = twitterOAuthConfig();
  const payload = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    code_verifier: session.codeVerifier
  }), "authorization", signal);
  const credential = credentialFromToken(payload);
  if (!credential.refreshToken) {
    throw new PlatformError("auth_required", "Twitter/X 未授予持续访问权限，请确认 offline.access 已启用后重新授权。");
  }
  return JSON.stringify(credential);
}

export async function activeTwitterCredential(credential: string, signal?: AbortSignal) {
  const parsed = parseTwitterCredential(credential);
  if (Date.parse(parsed.expiresAt) > Date.now() + 60_000) {
    return { credential, accessToken: parsed.accessToken, refreshed: false };
  }
  if (!parsed.refreshToken) throw new PlatformError("auth_required", "Twitter/X 授权已过期，请重新授权绑定。");
  const payload = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: parsed.refreshToken
  }), "refresh", signal);
  const refreshed = credentialFromToken(payload, parsed);
  return { credential: JSON.stringify(refreshed), accessToken: refreshed.accessToken, refreshed: true };
}

export function closeTwitterOAuthSessions() {
  oauthStates.clear();
}
