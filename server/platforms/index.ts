import type { Platform } from "../../shared/types.js";
import { bilibiliAdapter } from "./bilibili.js";
import type { PlatformAdapter } from "./types.js";
import { unavailableAdapter } from "./unavailable.js";

const adapters: Record<Platform, PlatformAdapter> = {
  bilibili: bilibiliAdapter,
  douyin: unavailableAdapter("douyin"),
  xiaohongshu: unavailableAdapter("xiaohongshu")
};

export function platformAdapter(platform: Platform) {
  return adapters[platform];
}
