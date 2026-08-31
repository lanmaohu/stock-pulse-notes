import assert from "node:assert/strict";
import { test } from "node:test";
import { errorFields, redactSensitiveText, sanitizeLogFields } from "./observability/logger.js";

test("platform secrets are redacted from logged errors", () => {
  const header = errorFields(new Error("Cookie: web_session=private-xhs; sessionid=private-douyin"));
  assert.equal(header.message, "Cookie: [REDACTED]");

  const storageState = redactSensitiveText(
    'storageState={"cookies":[{"name":"web_session","value":"private-cookie"}],"xsec_token":"private-token"}'
  );
  assert.equal(storageState.includes("private-cookie"), false);
  assert.equal(storageState.includes("private-token"), false);
  assert.match(storageState, /\[REDACTED]/);

  const authorization = redactSensitiveText("Authorization: Bearer private-access-token");
  assert.equal(authorization, "Authorization: [REDACTED]");

  const fields = sanitizeLogFields({
    message: "web_session=private-message-cookie",
    promptTokens: 42,
    nested: { credentialsCiphertext: "private-ciphertext", storageState: { cookies: [] } }
  });
  assert.equal(fields.message, "web_session=[REDACTED]");
  assert.equal(fields.promptTokens, 42);
  assert.deepEqual(fields.nested, { credentialsCiphertext: "[REDACTED]", storageState: "[REDACTED]" });
});
