import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { deepSeekModels, type ContentItem, type DeepSeekModel } from "../shared/types.js";
import { analyzeContent } from "./ai/content-analyzer.js";
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
    summarySections: [],
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
        choices: [{ message: { content: "{\"summarySections\":[],\"views\":[]}" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 }
      }), { status: 200 });
    });
    const result = await client.completeJson([{ role: "user", content: "test" }]);
    assert.equal(client.model, model);
    assert.equal(result.model, model);
    assert.equal(requestBody?.model, model);
    assert.deepEqual(requestBody?.thinking, { type: "disabled" });
    assert.deepEqual(requestBody?.response_format, { type: "json_object" });
    assert.equal("reasoning_effort" in (requestBody || {}), false);
    assert.equal(requestBody?.stream, false);
    assert.equal(retries, 1);
  }
});

test("DeepSeek client retries an empty JSON response once with text output", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  let calls = 0;
  const client = createDeepSeekClient("deepseek-v4-flash", async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: "", reasoning_content: "internal reasoning" }
        }],
        usage: { prompt_tokens: 11, completion_tokens: 7 }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"summarySections":[],"views":[]}' } }],
      usage: { prompt_tokens: 13, completion_tokens: 5 }
    }), { status: 200 });
  });

  const result = await client.completeJson([{ role: "user", content: "return JSON" }], { transportRetries: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(requestBodies[0]?.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in (requestBodies[0] || {}), false);
  assert.deepEqual(requestBodies[0]?.response_format, { type: "json_object" });
  assert.deepEqual(requestBodies[1]?.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in (requestBodies[1] || {}), false);
  assert.deepEqual(requestBodies[1]?.response_format, { type: "text" });
  assert.match(JSON.stringify(requestBodies[1]?.messages), /上一次生成结果为空/);
  assert.equal(result.content, '{"summarySections":[],"views":[]}');
  assert.deepEqual(result.usage, { promptTokens: 24, completionTokens: 12 });
});

test("DeepSeek client retries a truncated JSON response even when it contains partial content", async () => {
  let calls = 0;
  const client = createDeepSeekClient("deepseek-v4-flash", async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? {
      choices: [{ finish_reason: "length", message: { content: '{"summarySections":[' } }],
      usage: { prompt_tokens: 10, completion_tokens: 6_000 }
    } : {
      choices: [{ finish_reason: "stop", message: { content: '{"summarySections":[],"views":[]}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 }
    }), { status: 200 });
  });

  const result = await client.completeJson([{ role: "user", content: "return JSON" }], { transportRetries: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, '{"summarySections":[],"views":[]}');
  assert.deepEqual(result.usage, { promptTokens: 22, completionTokens: 6_004 });
});

test("DeepSeek client stops after one empty-response fallback", async () => {
  let calls = 0;
  const client = createDeepSeekClient("deepseek-v4-pro", async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "" } }]
    }), { status: 200 });
  });
  await assert.rejects(
    () => client.completeJson([{ role: "user", content: "return JSON" }], { transportRetries: 0 }),
    (error) => error instanceof AiError
      && error.code === "invalid_response"
      && /after one retry/.test(error.message)
  );
  assert.equal(calls, 2);
});

test("DeepSeek client does not retry an empty response after cancellation", async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = createDeepSeekClient("deepseek-v4-pro", async () => {
    calls += 1;
    controller.abort();
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "" } }]
    }), { status: 200 });
  });
  await assert.rejects(
    () => client.completeJson([{ role: "user", content: "return JSON" }], { signal: controller.signal }),
    (error) => error instanceof AiError && error.code === "aborted"
  );
  assert.equal(calls, 1);
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
    {"summarySections":[],"views":[{"symbols":[" RKLB ",3],"companies":["Rocket Lab"],"stance":"invalid","coreView":" 看多 ","evidence":["依据"],"risks":[],"confidence":"high","sourceSnippet":"原话"}]}
  \`\`\``]);
  const result = await analyzeContent(content({ transcriptSource: "metadata", status: "metadata_only" }), {
    client,
    log: () => undefined
  });
  assert.equal(result.views.length, 1);
  assert.deepEqual(result.summarySections, []);
  assert.deepEqual(result.views[0]?.symbols, ["RKLB"]);
  assert.equal(result.views[0]?.stance, "watch");
  assert.equal(result.views[0]?.confidence, "medium");
  assert.equal(result.views[0]?.model, "deepseek-v4-pro");
});

test("Xiaohongshu body text remains a full-confidence content source", async () => {
  const { client, calls } = fakeClient(['{"summarySections":[],"views":[{"symbols":[],"companies":["测试公司"],"coreView":"正文观点","evidence":[],"risks":[],"confidence":"high"}]}']);
  const result = await analyzeContent(content({
    platform: "xiaohongshu",
    contentType: "note",
    transcript: "小红书正文内容",
    transcriptSource: "body"
  }), { client, log: () => undefined });
  assert.equal(result.views[0]?.confidence, "high");
  assert.deepEqual(result.summarySections, []);
  assert.match(calls[0]?.messages[1]?.content || "", /正文、字幕或元数据/);
});

test("subtitle summary and views are produced by exactly one model request", async () => {
  const { client, calls } = fakeClient([
    '{"summarySections":[{"heading":"核心内容","body":"视频介绍字幕内容。","sourceQuotes":["字幕内容"]}],"views":[{"coreView":"字幕观点","symbols":[],"companies":[],"evidence":[],"risks":[]}]}'
  ]);
  const result = await analyzeContent(content(), { client, log: () => undefined });
  assert.equal(result.summarySections[0]?.heading, "核心内容");
  assert.deepEqual(result.summarySections[0]?.sourceQuotes, ["字幕内容"]);
  assert.equal(result.views[0]?.coreView, "字幕观点");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.transportRetries, 0);
});

test("invalid model output fails without a repair request", async () => {
  const { client, calls } = fakeClient(["bad", "unused"]);
  await assert.rejects(
    () => analyzeContent(content(), { client, log: () => undefined }),
    (error) => error instanceof AiError && error.code === "invalid_response"
  );
  assert.equal(calls.length, 1);
});

test("summary evidence is repaired once with verbatim transcript quotes", async () => {
  const { client, calls } = fakeClient([
    '{"summarySections":[{"heading":"核心内容","body":"视频介绍字幕内容。","sourceQuotes":["改写后的引用"]}],"views":[]}',
    '{"summarySections":[{"sourceQuotes":["字幕内容"]}]}'
  ]);
  const logs: Record<string, unknown>[] = [];
  const result = await analyzeContent(content(), { client, log: (entry) => logs.push(entry) });
  assert.deepEqual(result.summarySections[0]?.sourceQuotes, ["字幕内容"]);
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.messages[0]?.content || "", /只负责校对字幕原文引用/);
  assert.equal(logs[0]?.quoteRepairAttempted, true);
  assert.equal(logs[0]?.promptTokens, 20);
  assert.equal(logs[0]?.completionTokens, 10);
});

test("invalid repaired evidence fails after exactly one repair request", async () => {
  const { client, calls } = fakeClient([
    '{"summarySections":[{"heading":"虚构内容","body":"字幕没有表达的内容。","sourceQuotes":["不存在的原文"]}],"views":[]}',
    '{"summarySections":[{"sourceQuotes":["仍然不存在"]}]}'
  ]);
  await assert.rejects(
    () => analyzeContent(content(), { client, log: () => undefined }),
    (error) => error instanceof AiError && error.code === "invalid_response"
  );
  assert.equal(calls.length, 2);
});

test("summary evidence allows punctuation differences but not wording changes", async () => {
  const { client } = fakeClient([
    '{"summarySections":[{"heading":"摘要","body":"字幕摘要。","sourceQuotes":["字幕，内容！"]}],"views":[]}'
  ]);
  const result = await analyzeContent(content({ transcript: "字幕内容" }), { client, log: () => undefined });
  assert.deepEqual(result.summarySections[0]?.sourceQuotes, ["字幕内容"]);
});

test("summary evidence keeps verified quotes and drops an invalid extra quote", async () => {
  const { client, calls } = fakeClient([
    '{"summarySections":[{"heading":"摘要","body":"字幕摘要。","sourceQuotes":["字幕内容","改写后的引用"]}],"views":[]}'
  ]);
  const result = await analyzeContent(content({ transcript: "字幕内容" }), { client, log: () => undefined });
  assert.deepEqual(result.summarySections[0]?.sourceQuotes, ["字幕内容"]);
  assert.equal(calls.length, 1);
});

test("analysis logs metadata only and never logs transcript content", async () => {
  const secretTranscript = "PRIVATE_TRANSCRIPT_SHOULD_NOT_BE_LOGGED";
  const { client } = fakeClient(['{"summarySections":[{"heading":"摘要","body":"字幕内容摘要。","sourceQuotes":["PRIVATE_TRANSCRIPT_SHOULD_NOT_BE_LOGGED"]}],"views":[]}']);
  const logs: Record<string, unknown>[] = [];
  await analyzeContent(content({ transcript: secretTranscript }), { client, log: (entry) => logs.push(entry) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, "content_analysis_completed");
  assert.equal(logs[0]?.summarySectionCount, 1);
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
