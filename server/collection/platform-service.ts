import type { Platform } from "../../shared/types.js";
import { decryptCredential } from "../credentials.js";
import { getPlatformAccountWithCredential, updatePlatformAccountStatus } from "../repositories/platform.js";
import { PlatformError } from "../platforms/types.js";

export function platformCredential(platform: Platform) {
  const stored = getPlatformAccountWithCredential(platform);
  if (stored) {
    try {
      return { credential: decryptCredential(stored.encryptedCredential), accountId: stored.account.id };
    } catch {
      updatePlatformAccountStatus(stored.account.id, "error", { error: "平台登录凭证无法解密，请重新扫码绑定。" });
      throw new PlatformError("auth_required", "平台登录凭证无法解密，请重新扫码绑定。");
    }
  }
  const legacy = platform === "bilibili" ? process.env.BILIBILI_COOKIE?.trim() : "";
  if (legacy) return { credential: legacy, accountId: undefined };
  throw new PlatformError("auth_required", "请先绑定 B 站账号。");
}

export function collectionErrorDetails(error: unknown) {
  if (error instanceof PlatformError) return { code: error.code, message: error.message };
  return {
    code: "analysis_failed",
    message: error instanceof Error ? error.message : "采集任务失败。"
  };
}
