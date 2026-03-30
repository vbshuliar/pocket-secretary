import type { NormalizedBotRequest, TelegramUpdate } from "@/src/types";

function extractText(update: TelegramUpdate): string | null {
  return (
    update.message?.text ??
    update.message?.caption ??
    update.callback_query?.data ??
    null
  );
}

function extractVoiceFileId(update: TelegramUpdate): string | null {
  return update.message?.voice?.file_id ?? update.message?.audio?.file_id ?? null;
}

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
): NormalizedBotRequest {
  const message = update.message ?? update.callback_query?.message;
  const user = update.message?.from ?? update.callback_query?.from;

  return {
    updateId: update.update_id,
    chatId: message?.chat.id ?? null,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    messageId: message?.message_id ?? null,
    replyToMessageId: message?.reply_to_message?.message_id ?? null,
    text: extractText(update),
    voiceFileId: extractVoiceFileId(update),
    messageType: extractVoiceFileId(update) ? "voice" : "text",
    callbackQueryId: update.callback_query?.id ?? null,
    callbackData: update.callback_query?.data ?? null,
    raw: update,
  };
}
