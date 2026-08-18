import type { Platform } from "../../shared/types.js";
import { bilibiliAdapter } from "./bilibili.js";
import { douyinAdapter } from "./douyin.js";
import type { PlatformAdapter } from "./types.js";
import { xiaohongshuAdapter } from "./xiaohongshu.js";

const adapters: Record<Platform, PlatformAdapter> = {
  bilibili: bilibiliAdapter,
  douyin: douyinAdapter,
  xiaohongshu: xiaohongshuAdapter
};

export function platformAdapter(platform: Platform) {
  return adapters[platform];
}
