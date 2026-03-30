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

const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

const telegramBaseUrl = `https://api.telegram.org/bot${token}`;

async function telegram(method, body) {
  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.description ?? `Telegram request failed: ${response.status}`);
  }
  return json.result;
}

async function postUpdateToLocalApp(update) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (webhookSecret) {
    headers["x-telegram-bot-api-secret-token"] = webhookSecret;
  }

  const response = await fetch(`${appUrl}/api/telegram`, {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local app rejected update: ${response.status} ${text}`);
  }
}

async function main() {
  await telegram("deleteWebhook");
  console.log("Webhook cleared. Starting long polling.");

  let offset = 0;
  while (true) {
    try {
      const updates = await telegram(
        `getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`,
      );

      for (const update of updates) {
        offset = update.update_id + 1;
        await postUpdateToLocalApp(update);
      }
    } catch (error) {
      console.error("Polling error:", error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
