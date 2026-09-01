import assert from "node:assert/strict";
import { test } from "node:test";
import { createBilibiliRequestClient } from "./platforms/bilibili.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("Bilibili requests are serialized with a minimum interval", async () => {
  let clock = 0;
  const waits: number[] = [];
  let calls = 0;
  const client = createBilibiliRequestClient({
    fetcher: async () => {
      calls += 1;
      return jsonResponse({ code: 0, data: { call: calls } });
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
    random: () => 0,
    minIntervalMs: 1_500,
    jitterMs: 0,
    retryDelaysMs: [],
    finalCooldownMs: 60_000
  });

  const [first, second] = await Promise.all([
    client.requestJson<{ call: number }>("https://api.bilibili.com/first", "credential"),
    client.requestJson<{ call: number }>("https://api.bilibili.com/second", "credential")
  ]);

  assert.deepEqual([first.call, second.call], [1, 2]);
  assert.deepEqual(waits, [1_500]);
});

test("Bilibili request retries risk-control responses after a shared cooldown", async () => {
  let clock = 0;
  const waits: number[] = [];
  let calls = 0;
  const client = createBilibiliRequestClient({
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ code: -509, message: "请求过于频繁" })
        : jsonResponse({ code: 0, data: { recovered: true } });
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
    random: () => 0,
    minIntervalMs: 100,
    jitterMs: 0,
    retryDelaysMs: [8_000],
    finalCooldownMs: 60_000
  });

  const result = await client.requestJson<{ recovered: boolean }>(
    "https://api.bilibili.com/rate-limited",
    "credential"
  );

  assert.equal(result.recovered, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [8_000]);
});

test("Bilibili request stops after bounded retries and keeps the final cooldown", async () => {
  let clock = 0;
  const waits: number[] = [];
  let calls = 0;
  const client = createBilibiliRequestClient({
    fetcher: async () => {
      calls += 1;
      if (calls <= 2) return jsonResponse({}, 429);
      return jsonResponse({ code: 0, data: { recovered: true } });
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
    random: () => 0,
    minIntervalMs: 100,
    jitterMs: 0,
    retryDelaysMs: [500],
    finalCooldownMs: 2_000
  });

  await assert.rejects(
    () => client.requestJson("https://api.bilibili.com/still-limited", "credential"),
    (error: unknown) => error instanceof Error && error.message === "B 站暂时限制了请求，请稍后再试。"
  );
  const recovered = await client.requestJson<{ recovered: boolean }>(
    "https://api.bilibili.com/after-cooldown",
    "credential"
  );

  assert.equal(recovered.recovered, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 2_000]);
});
