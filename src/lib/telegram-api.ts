import { getTelegramBotToken } from "@/src/lib/env";
import type { TelegramUpdate } from "@/src/types";

type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
};

const TELEGRAM_BASE_URL = `https://api.telegram.org/bot${getTelegramBotToken()}`;

async function telegramRequest<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${TELEGRAM_BASE_URL}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = (await response.json()) as { ok: boolean; result: T; description?: string };

  if (!response.ok || !json.ok) {
    throw new Error(json.description ?? `Telegram request failed: ${response.status}`);
  }

  return json.result;
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  options?: {
    replyMarkup?: InlineKeyboardMarkup;
  },
): Promise<{ message_id: number }> {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: options?.replyMarkup,
  });
}

export async function editTelegramMessageReplyMarkup(
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup | null,
): Promise<void> {
  await telegramRequest("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function getTelegramFile(fileId: string): Promise<{ file_path: string }> {
  return telegramRequest("getFile", {
    file_id: fileId,
  });
}

export function getTelegramFileDownloadUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${getTelegramBotToken()}/${filePath}`;
}

export async function deleteTelegramWebhook(): Promise<void> {
  await telegramRequest("deleteWebhook");
}

export async function getTelegramUpdates(
  offset: number,
  timeoutSeconds = 30,
): Promise<TelegramUpdate[]> {
  return telegramRequest(
    `getUpdates?offset=${offset}&timeout=${timeoutSeconds}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`,
  );
}
