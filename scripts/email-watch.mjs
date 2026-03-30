import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filepath) {
  if (!fs.existsSync(filepath)) {
    return;
  }

  const lines = fs.readFileSync(filepath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx === -1) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env"));

const intervalMs = Number(process.env.EMAIL_WATCH_INTERVAL_MS ?? "10000");
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.replace(/^"(.*)"$/, "$1");
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.replace(/^"(.*)"$/, "$1");
const keyPrefix = process.env.UPSTASH_REDIS_KEY_PREFIX ?? "pocket-secretary";
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const encryptionSecret = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;

if (!telegramBotToken) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

if (!upstashUrl || !upstashToken) {
  throw new Error("Missing Upstash Redis configuration");
}

if (!googleClientId || !googleClientSecret) {
  throw new Error("Missing Google OAuth configuration");
}

if (!encryptionSecret) {
  throw new Error("Missing GOOGLE_TOKEN_ENCRYPTION_KEY");
}

function prefixedKey(key) {
  return `${keyPrefix}:${key}`;
}

async function upstash(command) {
  const response = await fetch(upstashUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstashToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`Upstash failed: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error);
  }

  return json.result ?? null;
}

async function decryptJson(value) {
  const { createDecipheriv, createHash } = await import("node:crypto");
  const parsed = JSON.parse(value);
  const key = /^[a-f0-9]{64}$/i.test(encryptionSecret)
    ? Buffer.from(encryptionSecret, "hex")
    : createHash("sha256").update(encryptionSecret, "utf8").digest();
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
  return JSON.parse(decrypted.toString("utf8"));
}

async function getLinkedUserIds() {
  const result = await upstash(["SMEMBERS", prefixedKey("google:linked-users")]);
  return (result ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

async function getEncryptedTokenRecord(userId) {
  return upstash(["GET", prefixedKey(`google:tokens:${userId}`)]);
}

async function setJsonKey(key, value) {
  await upstash(["SET", prefixedKey(key), JSON.stringify(value)]);
}

async function getJsonKey(key) {
  const result = await upstash(["GET", prefixedKey(key)]);
  return result ? JSON.parse(result) : null;
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status}`);
  }

  return response.json();
}

async function getValidGoogleAccessToken(userId) {
  const encrypted = await getEncryptedTokenRecord(userId);
  if (!encrypted) {
    return null;
  }

  const tokens = await decryptJson(encrypted);
  const expiresSoon = tokens.expiresAt ? tokens.expiresAt < Date.now() + 60_000 : false;
  if (!expiresSoon || !tokens.refreshToken) {
    return tokens.accessToken;
  }

  const refreshed = await refreshAccessToken(tokens.refreshToken);
  const updated = {
    ...tokens,
    accessToken: refreshed.access_token,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : null,
    scope: refreshed.scope ?? tokens.scope ?? null,
  };

  const { createCipheriv, createHash, randomBytes } = await import("node:crypto");
  const key = /^[a-f0-9]{64}$/i.test(encryptionSecret)
    ? Buffer.from(encryptionSecret, "hex")
    : createHash("sha256").update(encryptionSecret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(updated), "utf8");
  const encryptedUpdated = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await upstash([
    "SET",
    prefixedKey(`google:tokens:${userId}`),
    JSON.stringify({
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encryptedUpdated.toString("base64"),
    }),
  ]);

  return updated.accessToken;
}

async function googleJson(accessToken, url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google API failed: ${response.status} ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function listInboxMessages(accessToken) {
  const params = new URLSearchParams({
    labelIds: "INBOX",
    maxResults: "8",
  });
  const listed = await googleJson(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
  );
  const messages = listed.messages ?? [];
  const results = [];

  for (const message of messages) {
    const full = await googleJson(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    );
    const headers = full.payload?.headers ?? [];
    const subject = headers.find((header) => header.name === "Subject")?.value ?? "(no subject)";
    const from = headers.find((header) => header.name === "From")?.value ?? "(unknown sender)";
    const fromEmailMatch = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    results.push({
      id: full.id,
      threadId: full.threadId,
      internalDate: Number(full.internalDate ?? "0"),
      subject,
      from,
      fromEmail: fromEmailMatch ? fromEmailMatch[0] : null,
      snippet: full.snippet ?? "",
    });
  }

  return results.sort((a, b) => b.internalDate - a.internalDate);
}

async function sendTelegramMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.description ?? `Telegram send failed: ${response.status}`);
  }
}

function summarizeEmail(message) {
  const compact = message.snippet.trim().replace(/\s+/g, " ").slice(0, 180);
  return [
    "New email",
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    compact ? `Preview: ${compact}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function storeRecentEmailContext(userId, message) {
  await setJsonKey(`recent-email:${userId}`, {
    messageId: message.id,
    threadId: message.threadId ?? null,
    subject: message.subject,
    from: message.from,
    fromEmail: message.fromEmail,
    snippet: message.snippet,
    timestamp: Date.now(),
  });
}

async function checkOnce() {
  const userIds = await getLinkedUserIds();
  let notified = 0;

  for (const userId of userIds) {
    const accessToken = await getValidGoogleAccessToken(userId);
    if (!accessToken) {
      continue;
    }

    const messages = await listInboxMessages(accessToken);
    if (messages.length === 0) {
      continue;
    }

    const key = `gmail:cursor:${userId}`;
    const cursor = await getJsonKey(key);
    const latestInternalDate = messages[0].internalDate;

    if (!cursor) {
      await setJsonKey(key, {
        latestInternalDate,
        seenMessageIds: messages.map((message) => message.id).slice(0, 20),
      });
      console.log(`[email-watch] seeded cursor for user=${userId}`);
      continue;
    }

    const unseen = messages
      .filter(
        (message) =>
          message.internalDate > cursor.latestInternalDate &&
          !cursor.seenMessageIds.includes(message.id),
      )
      .sort((a, b) => a.internalDate - b.internalDate);

    for (const message of unseen) {
      await storeRecentEmailContext(userId, message);
      await sendTelegramMessage(userId, summarizeEmail(message));
      notified += 1;
    }

    await setJsonKey(key, {
      latestInternalDate: Math.max(cursor.latestInternalDate, latestInternalDate),
      seenMessageIds: messages.map((message) => message.id).slice(0, 20),
    });
  }

  console.log(`[email-watch] checked=${userIds.length} notified=${notified}`);
}

async function main() {
  console.log(`Starting email watcher every ${intervalMs}ms.`);
  while (true) {
    try {
      await checkOnce();
    } catch (error) {
      console.error("[email-watch] error:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
