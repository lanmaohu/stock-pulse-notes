import crypto from "node:crypto";

const algorithm = "aes-256-gcm";

function credentialKey() {
  const raw = process.env.PLATFORM_CREDENTIALS_KEY?.trim() || "";
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PLATFORM_CREDENTIALS_KEY must be a 32-byte base64 or 64-character hex value.");
  }
  return key;
}

export function assertCredentialEncryptionConfigured() {
  credentialKey();
}

export function encryptCredential(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptCredential(value: string) {
  const [version, ivText, tagText, encryptedText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Stored platform credential is invalid.");
  }
  const decipher = crypto.createDecipheriv(algorithm, credentialKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}
