import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptCredential, encryptCredential } from "./credentials.js";

process.env.PLATFORM_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");

test("platform credentials round-trip without exposing plaintext", () => {
  const plaintext = "SESSDATA=private-session; DedeUserID=42";
  const encrypted = encryptCredential(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(encrypted.includes("private-session"), false);
  assert.equal(decryptCredential(encrypted), plaintext);
});

test("tampered platform credentials are rejected", () => {
  const encrypted = encryptCredential("SESSDATA=private-session");
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptCredential(tampered));
});
