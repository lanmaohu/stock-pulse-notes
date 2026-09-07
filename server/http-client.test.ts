import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fetchWithPolicy } from "./http-client.js";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test("HTTP deadline remains active while reading a stalled response body", async () => {
  globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"partial\":"));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    }
  }));
  await assert.rejects(() => fetchWithPolicy("https://example.com", {}, { timeoutMs: 10, retries: 0 }), /aborted/);
});

test("HTTP policy preserves a buffered response and counts each transport attempt", async () => {
  const attempts: number[] = [];
  let calls = 0;
  globalThis.fetch = async () => new Response('{"ok":true}', {
    status: ++calls === 1 ? 503 : 200, headers: { "x-test": "preserved" }
  });
  const response = await fetchWithPolicy("https://example.com", {}, { onAttempt: (attempt) => attempts.push(attempt) });
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(response.headers.get("x-test"), "preserved");
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { ok: true });
});

test("caller cancellation also interrupts response body reading without retrying", async () => {
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    return new Response(new ReadableStream({
      start(body) {
        init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), { once: true });
        setTimeout(() => controller.abort(new Error("cancelled body")), 10);
      }
    }));
  };
  await assert.rejects(() => fetchWithPolicy("https://example.com", { signal: controller.signal }), /cancelled body/);
  assert.equal(calls, 1);
});

test("HTTP policy retries transient server failures once", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: calls === 1 ? 503 : 200 });
  };
  const response = await fetchWithPolicy("https://example.com", {}, { retries: 1, timeoutMs: 100 });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
test("HTTP policy does not retry authentication failures", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 401 });
  };
  const response = await fetchWithPolicy("https://example.com", {}, { retries: 1, timeoutMs: 100 });
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("HTTP policy aborts requests that exceed their timeout", async () => {
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  await assert.rejects(() => fetchWithPolicy("https://example.com", {}, { retries: 0, timeoutMs: 5 }), /aborted/);
});

test("HTTP policy propagates caller cancellation without retrying", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const request = fetchWithPolicy("https://example.com", { signal: controller.signal }, { retries: 1, timeoutMs: 1_000 });
  controller.abort(new Error("worker stopped"));
  await assert.rejects(() => request, /worker stopped/);
  assert.equal(calls, 1);
});
