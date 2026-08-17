import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("application routes", () => {
  test("a video card reveals the Bilibili subtitle transcript on demand", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/session") return json({ authenticated: false });
      if (path.startsWith("/api/content-creators")) return json({ creators: [] });
      if (path.startsWith("/api/content-insights")) return json({
        insights: [{
          content: {
            id: "video-1",
            platform: "bilibili",
            externalId: "BV1test",
            creatorId: "creator-1",
            creatorExternalId: "10001",
            creatorName: "测试博主",
            contentType: "video",
            title: "测试视频",
            description: "",
            tags: [],
            sourceUrl: "https://www.bilibili.com/video/BV1test",
            publishedAt: "2026-08-16T08:00:00.000Z",
            collectedAt: "2026-08-16T09:00:00.000Z",
            transcript: "这是从 B 站获取的完整字幕文字稿。",
            transcriptSource: "subtitle",
            status: "ready",
            analysisStatus: "success",
            createdAt: "2026-08-16T09:00:00.000Z",
            updatedAt: "2026-08-16T09:00:00.000Z"
          },
          views: []
        }],
        pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
        summary: { contentCount: 1, viewCount: 0, targetCount: 0 }
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    const transcriptToggle = await screen.findByText("B 站字幕文字稿");
    expect(screen.queryByText("这是从 B 站获取的完整字幕文字稿。")).not.toBeInTheDocument();
    transcriptToggle.click();
    expect(await screen.findByText("这是从 B 站获取的完整字幕文字稿。")).toBeInTheDocument();
  });

  test("the public insights route loads no administrator resources", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/auth/session") return json({ authenticated: false });
      if (path.startsWith("/api/content-creators")) return json({ creators: [] });
      if (path.startsWith("/api/content-insights")) return json({
        insights: [],
        pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
        summary: { contentCount: 0, viewCount: 0, targetCount: 0 }
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    await screen.findByText("没有匹配的观点");
    expect(screen.getAllByRole("link", { name: /最新观点/ })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /个人持仓/ })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /博主管理/ })).not.toBeInTheDocument();
    expect(requests).toContain("/api/auth/session");
    expect(requests).toContain("/api/content-insights?page=1&pageSize=10");
    expect(requests.some((path) => path.includes("publishedDate="))).toBe(false);
    expect(screen.getByRole("button", { name: "全部" })).toHaveClass("selected");
    expect(requests.some((path) => path.includes("/api/collection-"))).toBe(false);
  });

  test("an authenticated administrator sees public and management navigation together", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/session") return json({ authenticated: true });
      if (path.startsWith("/api/content-creators")) return json({ creators: [] });
      if (path.startsWith("/api/content-insights")) return json({
        insights: [],
        pagination: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
        summary: { contentCount: 0, viewCount: 0, targetCount: 0 }
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    await screen.findByText("没有匹配的观点");
    for (const label of ["最新观点", "个人持仓", "博主管理", "平台账号", "采集记录", "采集设置", "持仓管理"]) {
      expect(screen.getAllByRole("link", { name: new RegExp(label) }).length).toBeGreaterThan(0);
    }
  });

  test("an anonymous administrator route redirects to the dedicated login page", async () => {
    window.history.replaceState({}, "", "/admin/creators");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/session") return json({ authenticated: false });
      throw new Error(`Unexpected request ${String(input)}`);
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "管理员登录" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/login");
    expect(window.location.search).toContain("next=%2Fadmin%2Fcreators");
  });

  test("an authenticated administrator route loads only its active section", async () => {
    window.history.replaceState({}, "", "/admin/creators");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/auth/session") return json({ authenticated: true });
      if (path === "/api/creators") return json({ creators: [] });
      if (path === "/api/platform-accounts") return json({ accounts: [] });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    await screen.findByText("还没有订阅博主");
    await waitFor(() => expect(requests).toContain("/api/creators"));
    expect(requests).not.toContain("/api/collection-runs");
    expect(requests).not.toContain("/api/collection-settings");
  });
});
