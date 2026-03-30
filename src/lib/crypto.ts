import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getGoogleTokenEncryptionKey } from "@/src/lib/env";

function deriveKey(secret: string): Buffer {
  if (/^[a-f0-9]{64}$/i.test(secret)) {
    return Buffer.from(secret, "hex");
  }

  if (/^[A-Za-z0-9+/=]+$/.test(secret) && Buffer.from(secret, "base64").length >= 32) {
    return createHash("sha256").update(Buffer.from(secret, "base64")).digest();
  }

  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const key = deriveKey(getGoogleTokenEncryptionKey());
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

export function decryptJson<T>(value: string): T {
  const parsed = JSON.parse(value) as {
    iv: string;
    tag: string;
    data: string;
  };
  const key = deriveKey(getGoogleTokenEncryptionKey());
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8")) as T;
}
