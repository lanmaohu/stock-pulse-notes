import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { deepSeekModels, type ContentItem, type DeepSeekModel } from "../shared/types.js";
import { analyzeContentStockViews } from "./ai/content-analyzer.js";
import { createDeepSeekClient } from "./ai/deepseek-client.js";
import { AiError, type AiClient, type AiCompletionOptions, type AiMessage } from "./ai/types.js";

const originalKey = process.env.DEEPSEEK_API_KEY;

before(() => {
  process.env.DEEPSEEK_API_KEY = "test-secret-key";
});

after(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

function content(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "content-1",
    platform: "bilibili",
    externalId: "BV1",
    creatorId: "creator-1",
    creatorExternalId: "100",
    creatorName: "测试博主",
    contentType: "video",
    title: "测试视频",
    description: "测试简介",
    tags: ["股票"],
    sourceUrl: "https://www.bilibili.com/video/BV1",
    publishedAt: "2026-08-16T00:00:00.000Z",
    collectedAt: "2026-08-16T01:00:00.000Z",
    transcript: "字幕内容",
    transcriptSource: "subtitle",
    status: "ready",
    analysisStatus: "pending",
    createdAt: "2026-08-16T01:00:00.000Z",
    updatedAt: "2026-08-16T01:00:00.000Z",
    ...overrides
  };
}

function fakeClient(outputs: string[], model: DeepSeekModel = "deepseek-v4-pro") {
  const calls: Array<{ messages: AiMessage[]; options?: AiCompletionOptions }> = [];
  const client: AiClient = {
    model,
    async completeJson(messages, options) {
      calls.push({ messages, options });
      const output = outputs.shift();
      if (output === undefined) throw new Error("unexpected call");
      return { content: output, model: this.model, usage: { promptTokens: 10, completionTokens: 5 } };
    }
  };
  return { client, calls };
}

test("DeepSeek client uses either supported model with the same structured request options", async () => {
  for (const model of deepSeekModels) {
    let requestBody: Record<string, unknown> | undefined;
    let retries: number | undefined;
    const client = createDeepSeekClient(model, async (_input, init, policy) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      retries = policy?.retries;
      return new Response(JSON.stringify({
        model: "unexpected-upstream-alias",
        choices: [{ message: { content: "{\"views\":[]}" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 }
      }), { status: 200 });
    });
    const result = await client.completeJson([{ role: "user", content: "test" }]);
    assert.equal(client.model, model);
    assert.equal(result.model, model);
    assert.equal(requestBody?.model, model);
    assert.deepEqual(requestBody?.thinking, { type: "enabled" });
    assert.deepEqual(requestBody?.response_format, { type: "json_object" });
    assert.equal(requestBody?.reasoning_effort, "high");
    assert.equal(requestBody?.stream, false);
    assert.equal(retries, 1);
  }
});

test("unsupported explicit models fail while legacy AI_MODEL is ignored", () => {
  const previous = process.env.AI_MODEL;
  process.env.AI_MODEL = "deepseek-chat";
  try {
    assert.equal(createDeepSeekClient().model, "deepseek-v4-pro");
    assert.throws(() => createDeepSeekClient("deepseek-chat" as DeepSeekModel), /Unsupported DeepSeek model/);
  } finally {
    if (previous === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous;
  }
});

test("content analysis accepts fenced JSON and normalizes unsafe fields", async () => {
  const { client } = fakeClient([`\`\`\`json
    {"views":[{"symbols":[" RKLB ",3],"companies":["Rocket Lab"],"stance":"invalid","coreView":" 看多 ","evidence":["依据"],"risks":[],"confidence":"high","sourceSnippet":"原话"}]}
  \`\`\``]);
  const result = await analyzeContentStockViews(content({ transcriptSource: "metadata", status: "metadata_only" }), {
    client,
    log: () => undefined
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.symbols, ["RKLB"]);
  assert.equal(result[0]?.stance, "watch");
  assert.equal(result[0]?.confidence, "medium");
  assert.equal(result[0]?.model, "deepseek-v4-pro");
});

test("Xiaohongshu body text remains a full-confidence content source", async () => {
  const { client, calls } = fakeClient(['{"views":[{"symbols":[],"companies":["测试公司"],"coreView":"正文观点","evidence":[],"risks":[],"confidence":"high"}]}']);
  const result = await analyzeContentStockViews(content({
    platform: "xiaohongshu",
    contentType: "note",
    transcript: "小红书正文内容",
    transcriptSource: "body"
  }), { client, log: () => undefined });
  assert.equal(result[0]?.confidence, "high");
  assert.match(calls[0]?.messages[1]?.content || "", /正文、字幕或元数据/);
});

test("invalid model output gets one repair request without another transport retry", async () => {
  const { client, calls } = fakeClient([
    "not-json",
    '{"views":[{"coreView":"修复后的观点","symbols":[],"companies":[],"evidence":[],"risks":[]}]}'
  ]);
  const result = await analyzeContentStockViews(content(), { client, log: () => undefined });
  assert.equal(result[0]?.coreView, "修复后的观点");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.transportRetries, 1);
  assert.equal(calls[1]?.options?.transportRetries, 0);
});

test("a second invalid response fails with a stable error code", async () => {
  const { client } = fakeClient(["bad", "still bad"]);
  await assert.rejects(
    () => analyzeContentStockViews(content(), { client, log: () => undefined }),
    (error) => error instanceof AiError && error.code === "invalid_response"
  );
});

test("analysis logs metadata only and never logs transcript content", async () => {
  const secretTranscript = "PRIVATE_TRANSCRIPT_SHOULD_NOT_BE_LOGGED";
  const { client } = fakeClient(['{"views":[]}']);
  const logs: Record<string, unknown>[] = [];
  await analyzeContentStockViews(content({ transcript: secretTranscript }), { client, log: (entry) => logs.push(entry) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, "content_analysis_completed");
  assert.equal(JSON.stringify(logs).includes(secretTranscript), false);
});

test("authentication errors are returned without a second client request", async () => {
  let calls = 0;
  const client = createDeepSeekClient("deepseek-v4-pro", async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  });
  await assert.rejects(
    () => client.completeJson([{ role: "user", content: "test" }]),
    (error) => error instanceof AiError && error.code === "authentication"
  );
  assert.equal(calls, 1);
});
