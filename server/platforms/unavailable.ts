import type { Platform } from "../../shared/types.js";
import { PlatformError, type PlatformAdapter } from "./types.js";

export function unavailableAdapter(platform: Exclude<Platform, "bilibili">): PlatformAdapter {
  const unavailable = () => Promise.reject(new PlatformError("platform_error", `${platform} 暂未接入。`));
  return {
    platform,
    checkAccount: unavailable,
    searchCreators: unavailable,
    resolveCreator: unavailable,
    listCreatorContent: unavailable
  };
}
