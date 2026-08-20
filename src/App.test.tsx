import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function insightFixture(id: string, title: string, contentType: "video" | "note" = "video") {
  return {
    content: {
      id,
      platform: "bilibili",
      externalId: `external-${id}`,
      creatorId: "creator-1",
      creatorExternalId: "10001",
      creatorName: "测试博主",
      contentType,
      title,
      description: "",
      tags: [],
      sourceUrl: `https://www.bilibili.com/${contentType}/${id}`,
      coverUrl: `https://example.com/${id}.jpg`,
      publishedAt: "2026-08-16T08:00:00.000Z",
      collectedAt: "2026-08-16T09:00:00.000Z",
      transcript: contentType === "video" ? `${title}的完整字幕文字稿。` : "",
      transcriptSource: contentType === "video" ? "subtitle" : "metadata",
      status: "ready",
      analysisStatus: "success",
      createdAt: "2026-08-16T09:00:00.000Z",
      updatedAt: "2026-08-16T09:00:00.000Z"
    },
    views: [{
      id: `view-${id}`,
      contentId: id,
      platform: "bilibili",
      creatorId: "creator-1",
      creatorExternalId: "10001",
      creatorName: "测试博主",
      title,
      sourceUrl: `https://www.bilibili.com/${contentType}/${id}`,
      publishedAt: "2026-08-16T08:00:00.000Z",
      collectedAt: "2026-08-16T09:00:00.000Z",
      symbols: [id.toUpperCase()],
      companies: [],
      stance: "bullish",
      coreView: `${title}的核心观点`,
      evidence: [`${title}的依据`],
      risks: [`${title}的风险`],
      confidence: "high",
      sourceSnippet: `${title}的原话`,
      model: "test-model",
      createdAt: "2026-08-16T09:00:00.000Z"
    }]
  };
}

function mockPublicInsights(insights: unknown[]) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/session") return json({ authenticated: false });
    if (path.startsWith("/api/content-creators")) return json({ creators: [] });
    if (path.startsWith("/api/content-insights")) return json({
      insights,
      pagination: { page: 1, pageSize: 10, totalItems: insights.length, totalPages: 1 },
      summary: { contentCount: insights.length, viewCount: insights.length, targetCount: insights.length }
    });
    throw new Error(`Unexpected request ${path}`);
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("application routes", () => {
  test("an insight card is collapsed by default and reveals its details and transcript on demand", async () => {
    mockPublicInsights([insightFixture("video-1", "测试视频")]);

    render(<App />);

    const expandButton = await screen.findByRole("button", { name: "展开观点：测试视频" });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "测试视频" })).toBeInTheDocument();
    expect(screen.queryByText("B 站字幕文字稿")).not.toBeInTheDocument();
    expect(screen.queryByText("测试视频的核心观点")).not.toBeInTheDocument();
    expect(screen.queryByText("测试视频的依据")).not.toBeInTheDocument();
    expect(screen.queryByText("测试视频的风险")).not.toBeInTheDocument();

    expandButton.click();
    const collapseButton = await screen.findByRole("button", { name: "收起观点：测试视频" });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("测试视频的核心观点")).toBeInTheDocument();

    const transcriptToggle = screen.getByText("B 站字幕文字稿");
    expect(screen.queryByText("测试视频的完整字幕文字稿。")).not.toBeInTheDocument();
    transcriptToggle.click();
    expect(await screen.findByText("测试视频的完整字幕文字稿。")).toBeInTheDocument();

    collapseButton.click();
    expect(await screen.findByRole("button", { name: "展开观点：测试视频" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("测试视频的核心观点")).not.toBeInTheDocument();
  });

  test("source links do not toggle a collapsed card while the overview does", async () => {
    mockPublicInsights([insightFixture("video-1", "测试视频")]);

    render(<App />);
    const expandButton = await screen.findByRole("button", { name: "展开观点：测试视频" });

    fireEvent.click(screen.getByRole("link", { name: "打开 测试视频" }));
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("link", { name: "测试视频" }));
    expect(expandButton).toHaveAttribute("aria-expanded", "false");

    const overview = screen.getByText("测试博主").closest(".content-overview");
    expect(overview).not.toBeNull();
    fireEvent.click(overview!);
    expect(await screen.findByRole("button", { name: "收起观点：测试视频" })).toHaveAttribute("aria-expanded", "true");
  });

  test("video and note cards expand independently", async () => {
    mockPublicInsights([
      insightFixture("video-1", "测试视频"),
      insightFixture("note-1", "测试图文", "note")
    ]);

    render(<App />);
    const videoButton = await screen.findByRole("button", { name: "展开观点：测试视频" });
    const noteButton = screen.getByRole("button", { name: "展开观点：测试图文" });

    fireEvent.click(videoButton);
    fireEvent.click(noteButton);
    expect(await screen.findByText("测试视频的核心观点")).toBeInTheDocument();
    expect(await screen.findByText("测试图文的核心观点")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起观点：测试视频" }));
    await waitFor(() => expect(screen.queryByText("测试视频的核心观点")).not.toBeInTheDocument());
    expect(screen.getByText("测试图文的核心观点")).toBeInTheDocument();
  });

  test("a Xiaohongshu note exposes its body as a first-class content source", async () => {
    const insight = insightFixture("xhs-note", "小红书测试笔记", "note");
    insight.content.platform = "xiaohongshu";
    insight.content.transcript = "这是用于分析的完整笔记正文。";
    insight.content.transcriptSource = "body";
    insight.views[0]!.platform = "xiaohongshu";
    mockPublicInsights([insight]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "展开观点：小红书测试笔记" }));
    const bodyLabels = await screen.findAllByText("正文内容");
    expect(bodyLabels.length).toBe(2);
    fireEvent.click(bodyLabels[1]!);
    expect(await screen.findByText("这是用于分析的完整笔记正文。")).toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: /个人持仓/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /博主管理/ })).not.toBeInTheDocument();
    expect(requests).toContain("/api/auth/session");
    expect(requests).toContain("/api/content-insights?page=1&pageSize=10");
    expect(requests.some((path) => path.includes("publishedDate="))).toBe(false);
    expect(screen.getByRole("button", { name: "全部" })).toHaveClass("selected");
    expect(requests.some((path) => path.includes("/api/collection-"))).toBe(false);
  });

  test("an anonymous portfolio route redirects to administrator login without loading portfolio data", async () => {
    window.history.replaceState({}, "", "/portfolio");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/auth/session") return json({ authenticated: false });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "管理员登录" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/login");
    expect(window.location.search).toContain("next=%2Fportfolio");
    expect(requests).not.toContain("/api/portfolio");
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
    for (const platform of ["B站", "抖音", "小红书", "Twitter/X"]) expect(screen.getByRole("button", { name: new RegExp(platform) })).toBeInTheDocument();
    await waitFor(() => expect(requests).toContain("/api/creators"));
    expect(requests).not.toContain("/api/collection-runs");
    expect(requests).not.toContain("/api/collection-settings");
  });

  test("platform accounts page offers QR and OAuth binding for all four sources", async () => {
    window.history.replaceState({}, "", "/admin/accounts?twitter=credits");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/session") return json({ authenticated: true });
      if (path === "/api/platform-accounts") return json({ accounts: [] });
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<App />);
    expect((await screen.findAllByRole("button", { name: "扫码绑定" })).length).toBe(3);
    expect(screen.getByRole("button", { name: "授权绑定" })).toBeInTheDocument();
    expect(screen.getByText("B站")).toBeInTheDocument();
    expect(screen.getByText("抖音")).toBeInTheDocument();
    expect(screen.getByText("小红书")).toBeInTheDocument();
    expect(screen.getByText("Twitter/X")).toBeInTheDocument();
    expect(screen.getByText("Twitter/X API 额度不足，请在 X Developer Console 充值后重新授权。")).toBeInTheDocument();
    expect(screen.queryByText("后续版本")).not.toBeInTheDocument();
  });
});
