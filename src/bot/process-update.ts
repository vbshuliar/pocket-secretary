import { randomUUID } from "node:crypto";
import { getAppUrl, getConnectTokenTtlSeconds, getDefaultTimezone } from "@/src/lib/env";
import {
  createCalendarEvent,
  createGoogleDoc,
  deleteGoogleTokens,
  getGoogleEmail,
  getValidGoogleAccessToken,
  searchGoogleContacts,
  sendGmailMessage,
} from "@/src/lib/google-workspace";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageReplyMarkup,
  getTelegramFile,
  getTelegramFileDownloadUrl,
  sendTelegramMessage,
} from "@/src/lib/telegram-api";
import { transcribeAudioFromUrl } from "@/src/lib/openai";
import { deleteKey, getJson, hasSeenTelegramUpdate, setJson } from "@/src/lib/upstash";
import { runPocketSecretary } from "@/src/agent";
import { normalizeTelegramUpdate } from "@/src/bot/telegram";
import type {
  AgentAction,
  CalendarEventPayload,
  ConnectTokenRecord,
  ConversationState,
  GmailDraftPayload,
  GoogleDocPayload,
  PendingActionRecord,
  RecentEmailContext,
  TelegramUpdate,
} from "@/src/types";

const CONNECT_TOKEN_KEY = (token: string) => `connect-token:${token}`;
const PENDING_ACTION_KEY = (telegramUserId: number) => `pending-action:${telegramUserId}`;
const CONVERSATION_KEY = (telegramUserId: number) => `conversation:${telegramUserId}`;
const RECENT_EMAIL_KEY = (telegramUserId: number) => `recent-email:${telegramUserId}`;
const CONVERSATION_TTL_SECONDS = 60 * 60 * 24;
const DISCONNECT_CALLBACK = "disconnect_google";

function connectUrl(token: string): string {
  return `${getAppUrl()}/connect?token=${encodeURIComponent(token)}`;
}

function canUseTelegramUrlButton(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function actionReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: "confirm" },
        { text: "Cancel", callback_data: "cancel" },
      ],
    ],
  };
}

async function createConnectToken(record: ConnectTokenRecord): Promise<string> {
  const token = randomUUID();
  await setJson(CONNECT_TOKEN_KEY(token), record, getConnectTokenTtlSeconds());
  return token;
}

export async function getConnectTokenRecord(
  token: string,
): Promise<ConnectTokenRecord | null> {
  return getJson<ConnectTokenRecord>(CONNECT_TOKEN_KEY(token));
}

export async function consumeConnectToken(
  token: string,
): Promise<ConnectTokenRecord | null> {
  const record = await getConnectTokenRecord(token);
  if (!record) {
    return null;
  }

  await deleteKey(CONNECT_TOKEN_KEY(token));
  return record;
}

async function getConversationState(userId: number): Promise<ConversationState> {
  return (await getJson<ConversationState>(CONVERSATION_KEY(userId))) ?? { turns: [] };
}

async function appendConversationTurn(
  userId: number,
  role: "user" | "assistant",
  text: string,
): Promise<ConversationState> {
  const current = await getConversationState(userId);
  const next = {
    turns: [...current.turns, { role, text, timestamp: Date.now() }].slice(-12),
  };
  await setJson(CONVERSATION_KEY(userId), next, CONVERSATION_TTL_SECONDS);
  return next;
}

async function getRecentEmailContext(
  userId: number,
): Promise<RecentEmailContext | null> {
  return getJson<RecentEmailContext>(RECENT_EMAIL_KEY(userId));
}

async function sendConnectPrompt(
  chatId: number,
  userId: number,
  username: string | null,
): Promise<void> {
  const token = await createConnectToken({
    telegramUserId: userId,
    chatId,
    username,
  });
  const url = connectUrl(token);
  const text =
    "Connect your Google account to Pocket Secretary to unlock Calendar, Gmail, Docs, and Contacts.";

  if (canUseTelegramUrlButton(url)) {
    await sendTelegramMessage(chatId, text, {
      replyMarkup: {
        inline_keyboard: [[{ text: "Connect Google", url }]],
      },
    });
    return;
  }

  await sendTelegramMessage(
    chatId,
    `${text}\n\nOpen this link in your browser:\n${url}`,
  );
}

async function sendReconnectStatus(
  chatId: number,
  userId: number,
  username: string | null,
  email: string | null,
): Promise<void> {
  const token = await createConnectToken({
    telegramUserId: userId,
    chatId,
    username,
  });
  const url = connectUrl(token);
  const text = email ? `Connected Google account: ${email}` : "Google account connected.";

  if (canUseTelegramUrlButton(url)) {
    await sendTelegramMessage(chatId, text, {
      replyMarkup: {
        inline_keyboard: [
          [{ text: "Reconnect Google", url }],
          [{ text: "Disconnect Google", callback_data: DISCONNECT_CALLBACK }],
        ],
      },
    });
    return;
  }

  await sendTelegramMessage(
    chatId,
    `${text}\n\nReconnect link:\n${url}`,
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "Disconnect Google", callback_data: DISCONNECT_CALLBACK }]],
      },
    },
  );
}

async function disconnectGoogleAccount(
  userId: number,
  chatId: number,
  callbackQueryId: string | null,
  messageId: number | null,
): Promise<boolean> {
  await deleteGoogleTokens(userId);
  await deleteKey(PENDING_ACTION_KEY(userId));
  await deleteKey(CONVERSATION_KEY(userId));

  if (callbackQueryId) {
    await answerTelegramCallbackQuery(callbackQueryId, "Google disconnected.");
  }
  if (messageId) {
    await editTelegramMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: [],
    });
  }
  await sendTelegramMessage(chatId, "Google account disconnected.");
  return true;
}

async function resolveContacts(
  accessToken: string,
  names: string[],
): Promise<{ matches: Array<{ displayName: string; email: string }>; warning: string | null }> {
  const matches: Array<{ displayName: string; email: string }> = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const contacts = await searchGoogleContacts(accessToken, name);
    if (contacts.length === 0) {
      return {
        matches: [],
        warning: `I could not find a contact for "${name}".`,
      };
    }
    if (contacts.length > 1) {
      return {
        matches: [],
        warning: `I found multiple contacts for "${name}". Try using the full name.`,
      };
    }

    matches.push(contacts[0]);
  }

  return {
    matches,
    warning: null,
  };
}

function summarizeAction(action: AgentAction): string {
  if (!action.payload) {
    return action.userVisibleSummary;
  }

  switch (action.actionType) {
    case "create_calendar_event": {
      const payload = action.payload as CalendarEventPayload;
      return [
        "Calendar draft ready:",
        `Title: ${payload.title}`,
        `Start: ${payload.startAt ?? "missing"}`,
        `Timezone: ${payload.timezone}`,
        `Guests: ${payload.attendees.map((guest) => guest.email).join(", ") || "none"}`,
      ].join("\n");
    }
    case "create_gmail_draft": {
      const payload = action.payload as GmailDraftPayload;
      return [
        "Email ready to send:",
        `To: ${payload.to.map((recipient) => recipient.email).join(", ")}`,
        `Subject: ${payload.subject}`,
      ].join("\n");
    }
    case "create_google_doc": {
      const payload = action.payload as GoogleDocPayload;
      return ["Google Doc ready:", `Title: ${payload.title}`].join("\n");
    }
    default:
      return action.userVisibleSummary;
  }
}

async function executePendingAction(record: PendingActionRecord): Promise<string> {
  const accessToken = await getValidGoogleAccessToken(record.telegramUserId);
  if (!accessToken) {
    return "Your Google account is no longer connected. Use /start to reconnect it.";
  }

  switch (record.action.actionType) {
    case "create_calendar_event": {
      const result = await createCalendarEvent(
        accessToken,
        record.action.payload as CalendarEventPayload,
      );
      return result.htmlLink
        ? `Calendar event created.\n${result.htmlLink}`
        : "Calendar event created.";
    }
    case "create_gmail_draft": {
      await sendGmailMessage(accessToken, record.action.payload as GmailDraftPayload);
      return "Email sent.";
    }
    case "create_google_doc": {
      const result = await createGoogleDoc(accessToken, record.action.payload as GoogleDocPayload);
      return result.documentId
        ? `Google Doc created.\nhttps://docs.google.com/document/d/${result.documentId}/edit`
        : "Google Doc created.";
    }
    default:
      return "I could not execute that action.";
  }
}

async function maybeHandlePendingConfirmation(
  requestText: string | null,
  userId: number,
  chatId: number,
  callbackQueryId: string | null,
  messageId: number | null,
  callbackData: string | null,
): Promise<boolean> {
  const normalized = callbackData
    ? callbackData.trim().toLowerCase()
    : requestText?.trim().toLowerCase() ?? "";
  const isConfirm = ["yes", "y", "confirm"].includes(normalized);
  const isCancel = ["no", "n", "cancel"].includes(normalized);
  if (!isConfirm && !isCancel) {
    return false;
  }

  const pending = await getJson<PendingActionRecord>(PENDING_ACTION_KEY(userId));
  if (!pending) {
    if (callbackQueryId) {
      await answerTelegramCallbackQuery(callbackQueryId, "Nothing pending.");
    }
    return false;
  }

  const pendingMessageId = messageId ?? pending.messageId;

  if (isCancel) {
    await deleteKey(PENDING_ACTION_KEY(userId));
    if (callbackQueryId) {
      await answerTelegramCallbackQuery(callbackQueryId, "Cancelled.");
    }
    if (pendingMessageId) {
      await editTelegramMessageReplyMarkup(chatId, pendingMessageId, null);
    }
    await appendConversationTurn(userId, "assistant", "Cancelled.");
    await sendTelegramMessage(chatId, "Cancelled.");
    return true;
  }

  const resultMessage = await executePendingAction(pending);
  await deleteKey(PENDING_ACTION_KEY(userId));
  if (callbackQueryId) {
    await answerTelegramCallbackQuery(callbackQueryId, "Done.");
  }
  if (pendingMessageId) {
    await editTelegramMessageReplyMarkup(chatId, pendingMessageId, null);
  }
  await appendConversationTurn(userId, "assistant", resultMessage);
  await sendTelegramMessage(chatId, resultMessage);
  return true;
}

async function processConnectedRequest(
  update: TelegramUpdate,
  chatId: number,
  userId: number,
): Promise<void> {
  const request = normalizeTelegramUpdate(update);
  const accessToken = await getValidGoogleAccessToken(userId);
  if (!accessToken) {
    await sendConnectPrompt(chatId, userId, request.username);
    return;
  }

  let sourceText = request.text ?? "";
  if (request.messageType === "voice" && request.voiceFileId) {
    const file = await getTelegramFile(request.voiceFileId);
    sourceText = await transcribeAudioFromUrl(
      getTelegramFileDownloadUrl(file.file_path),
    );
    if (!sourceText) {
      await sendTelegramMessage(chatId, "I could not transcribe that voice note.");
      return;
    }
    await sendTelegramMessage(chatId, `Transcribed: ${sourceText}`);
  }

  if (!sourceText.trim()) {
    await sendTelegramMessage(chatId, "Send a text or voice message with a request.");
    return;
  }

  const conversation = await appendConversationTurn(userId, "user", sourceText);
  const recentEmail = await getRecentEmailContext(userId);
  const action = await runPocketSecretary(
    request,
    sourceText,
    conversation.turns,
    recentEmail,
  );

  if (action.requiresClarification || action.status === "requires_clarification") {
    const replyText = action.clarificationQuestion ?? action.userVisibleSummary;
    await appendConversationTurn(userId, "assistant", replyText);
    await sendTelegramMessage(chatId, replyText);
    return;
  }

  if (action.actionType === "unsupported_request" || !action.payload) {
    await appendConversationTurn(userId, "assistant", action.userVisibleSummary);
    await sendTelegramMessage(chatId, action.userVisibleSummary);
    return;
  }

  if (action.actionType === "create_calendar_event") {
    const payload = action.payload as CalendarEventPayload;
    const resolved = await resolveContacts(accessToken, payload.attendeeNames);
    if (resolved.warning) {
      await appendConversationTurn(userId, "assistant", resolved.warning);
      await sendTelegramMessage(chatId, resolved.warning);
      return;
    }
    payload.attendees = resolved.matches;
    payload.timezone = payload.timezone || getDefaultTimezone();
  }

  if (action.actionType === "create_gmail_draft") {
    const payload = action.payload as GmailDraftPayload;
    if (payload.to.length === 0) {
      const resolved = await resolveContacts(accessToken, payload.toNames);
      if (resolved.warning) {
        await appendConversationTurn(userId, "assistant", resolved.warning);
        await sendTelegramMessage(chatId, resolved.warning);
        return;
      }
      payload.to = resolved.matches;
    }
  }

  const summary = summarizeAction(action);
  await appendConversationTurn(userId, "assistant", summary);
  const sent = await sendTelegramMessage(chatId, summary, {
    replyMarkup: actionReplyMarkup(),
  });
  await setJson(
    PENDING_ACTION_KEY(userId),
    {
      telegramUserId: userId,
      chatId,
      messageId: sent.message_id,
      action,
      sourceText,
    } satisfies PendingActionRecord,
    60 * 30,
  );
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<{
  ok: boolean;
  ignored?: boolean;
}> {
  if (await hasSeenTelegramUpdate(update.update_id)) {
    return { ok: true, ignored: true };
  }

  const request = normalizeTelegramUpdate(update);
  if (!request.chatId || !request.userId) {
    return { ok: true, ignored: true };
  }

  if (request.callbackData === DISCONNECT_CALLBACK) {
    await disconnectGoogleAccount(
      request.userId,
      request.chatId,
      request.callbackQueryId,
      request.messageId,
    );
    return { ok: true };
  }

  const handledConfirmation = await maybeHandlePendingConfirmation(
    request.text,
    request.userId,
    request.chatId,
    request.callbackQueryId,
    request.messageId,
    request.callbackData,
  );
  if (handledConfirmation) {
    return { ok: true };
  }

  const text = request.text?.trim().toLowerCase() ?? "";
  if (text === "/start" || text === "/connect") {
    await sendConnectPrompt(request.chatId, request.userId, request.username);
    return { ok: true };
  }

  const googleAccessToken = await getValidGoogleAccessToken(request.userId);
  if (!googleAccessToken) {
    await sendConnectPrompt(request.chatId, request.userId, request.username);
    return { ok: true };
  }

  if (text === "/status") {
    const email = await getGoogleEmail(googleAccessToken);
    await sendReconnectStatus(
      request.chatId,
      request.userId,
      request.username,
      email,
    );
    return { ok: true };
  }

  await processConnectedRequest(update, request.chatId, request.userId);
  return { ok: true };
}
