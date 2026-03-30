import { randomUUID } from "node:crypto";
import { getAppUrl, getConnectTokenTtlSeconds, getDefaultTimezone } from "@/src/lib/env";
import {
  createCalendarEvent,
  createGoogleDoc,
  deleteGoogleTokens,
  getGoogleEmail,
  getValidGoogleAccessToken,
  listCalendarEvents,
  searchGoogleContacts,
  sendGmailMessage,
  updateCalendarInviteResponse,
} from "@/src/lib/google-workspace";
import {
  answerTelegramCallbackQuery,
  botMenuReplyMarkup,
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
  CalendarInvitePayload,
  ConnectTokenRecord,
  ConversationState,
  GmailDraftPayload,
  GoogleDocPayload,
  PendingActionRecord,
  PendingClarificationRecord,
  RecentEmailContext,
  TelegramUpdate,
} from "@/src/types";

const CONNECT_TOKEN_KEY = (token: string) => `connect-token:${token}`;
const PENDING_ACTION_KEY = (telegramUserId: number) => `pending-action:${telegramUserId}`;
const PENDING_CLARIFICATION_KEY = (telegramUserId: number) => `pending-clarification:${telegramUserId}`;
const CONVERSATION_KEY = (telegramUserId: number) => `conversation:${telegramUserId}`;
const RECENT_EMAIL_KEY = (telegramUserId: number) => `recent-email:${telegramUserId}`;
const TELEGRAM_EMAIL_CONTEXT_KEY = (telegramUserId: number, messageId: number) =>
  `telegram-email-context:${telegramUserId}:${messageId}`;
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

async function sendBotMessage(
  chatId: number,
  text: string,
  options?: {
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
    } | {
      keyboard: Array<Array<{
        text: string;
        web_app?: {
          url: string;
        };
      }>>;
      resize_keyboard?: boolean;
      is_persistent?: boolean;
    };
    userId?: number | null;
    username?: string | null;
  },
): Promise<{ message_id: number }> {
  const directConnectUrl = options?.userId
    ? await createConnectUrlForUser(chatId, options.userId, options.username ?? null)
    : null;
  const menuMarkup = botMenuReplyMarkup(directConnectUrl);
  return sendTelegramMessage(chatId, text, {
    replyMarkup: options?.replyMarkup ?? menuMarkup,
  });
}

async function createConnectToken(record: ConnectTokenRecord): Promise<string> {
  const token = randomUUID();
  await setJson(CONNECT_TOKEN_KEY(token), record, getConnectTokenTtlSeconds());
  return token;
}

export async function createConnectUrlForUser(
  chatId: number,
  userId: number,
  username: string | null,
): Promise<string> {
  const token = await createConnectToken({
    telegramUserId: userId,
    chatId,
    username,
  });
  return connectUrl(token);
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

async function getReplyEmailContext(
  userId: number,
  replyToMessageId: number | null,
): Promise<RecentEmailContext | null> {
  if (!replyToMessageId) {
    return null;
  }

  return getJson<RecentEmailContext>(
    TELEGRAM_EMAIL_CONTEXT_KEY(userId, replyToMessageId),
  );
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

  await sendBotMessage(
    chatId,
    `${text}\n\nOpen this link in your browser:\n${url}`,
    {
      userId,
      username,
    },
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

  await sendBotMessage(
    chatId,
    `${text}\n\nReconnect link:\n${url}`,
    {
      userId,
      username,
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
  await sendBotMessage(chatId, "Google account disconnected.", { userId });
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
        "Body:",
        payload.bodyText || "(empty)",
      ].join("\n");
    }
    case "manage_calendar_invite": {
      const payload = action.payload as CalendarInvitePayload;
      return [
        payload.operation === "check_conflicts"
          ? "Calendar invite conflict check:"
          : "Calendar invite ready:",
        `Action: ${payload.operation}`,
        `Title: ${payload.title}`,
        `Start: ${payload.startAt}`,
        `End: ${payload.endAt}`,
        `Timezone: ${payload.timezone}`,
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

function toLocalMinuteKey(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value.slice(0, 16);
  }

  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

function dayBoundsUtc(localDateTime: string): { timeMin: string; timeMax: string } {
  const day = localDateTime.slice(0, 10);
  return {
    timeMin: `${day}T00:00:00.000Z`,
    timeMax: `${day}T23:59:59.999Z`,
  };
}

async function inspectCalendarInvite(
  accessToken: string,
  payload: CalendarInvitePayload,
): Promise<{
  matchedEventId: string | null;
  conflicts: Array<{ title: string; startAt: string | null; htmlLink?: string }>;
}> {
  const { timeMin, timeMax } = dayBoundsUtc(payload.startAt);
  const events = (await listCalendarEvents(accessToken, timeMin, timeMax)).filter(
    (event) => event.status !== "cancelled",
  );
  const targetStartKey = toLocalMinuteKey(payload.startAt, payload.timezone);
  const targetEndKey = toLocalMinuteKey(payload.endAt, payload.timezone);

  const matchedEvent =
    events.find(
      (event) =>
        normalizeInviteText(event.summary) === normalizeInviteText(payload.title) &&
        event.startAt &&
        event.endAt &&
        toLocalMinuteKey(event.startAt, payload.timezone) === targetStartKey &&
        toLocalMinuteKey(event.endAt, payload.timezone) === targetEndKey,
    ) ??
    events.find(
      (event) =>
        event.startAt &&
        event.endAt &&
        toLocalMinuteKey(event.startAt, payload.timezone) === targetStartKey &&
        toLocalMinuteKey(event.endAt, payload.timezone) === targetEndKey &&
        (!payload.organizerEmail || event.organizerEmail === payload.organizerEmail),
    ) ??
    null;

  const conflicts = events.filter((event) => {
    if (!event.startAt || !event.endAt || event.id === matchedEvent?.id) {
      return false;
    }

    const eventStart = new Date(event.startAt).getTime();
    const eventEnd = new Date(event.endAt).getTime();
    const targetStart = new Date(
      `${payload.startAt}${payload.timezone === "Europe/London" ? "+01:00" : "Z"}`,
    ).getTime();
    const targetEnd = new Date(
      `${payload.endAt}${payload.timezone === "Europe/London" ? "+01:00" : "Z"}`,
    ).getTime();

    return eventStart < targetEnd && eventEnd > targetStart;
  });

  return {
    matchedEventId: matchedEvent?.id ?? null,
    conflicts: conflicts.map((event) => ({
      title: event.summary,
      startAt: event.startAt,
      htmlLink: event.htmlLink,
    })),
  };
}

function normalizeInviteText(value: string): string {
  return value.trim().toLowerCase();
}

function isEmailReplyCheckIntent(text: string): boolean {
  return /\b(check|see|am i|i'm|tell me)\b.*\b(busy|free|available|clash|clashes|conflict|conflicts)\b/i.test(
    text,
  );
}

function looksLikeDirectReplyBody(text: string): boolean {
  return /^(yes|no|sorry|i'm|i am|i can|i can't|i cannot|unfortunately|thanks|thank you|that works|works for me)\b/i.test(
    text.trim(),
  );
}

function looksLikeRecipientClarification(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) {
    return false;
  }
  if (/[.?!,:;]/.test(trimmed)) {
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return false;
  }

  return words.every((word) => /^[a-zA-Z][a-zA-Z'-]*$/.test(word));
}

function inferRecipientNamesFromEmailRequest(sourceText: string): string[] {
  const patterns = [
    /\b(?:email|write(?:\s+an)?\s+email|send(?:\s+an)?\s+email)\s+to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
    /\bask\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+if\b/,
    /\btell\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+that\b/,
  ];

  for (const pattern of patterns) {
    const match = sourceText.match(pattern);
    if (match?.[1]) {
      return [match[1].trim()];
    }
  }

  return [];
}

function isSuspiciousRecipientExtraction(
  toNames: string[],
  sourceText: string,
): boolean {
  if (toNames.length === 0) {
    return true;
  }

  const normalizedSource = sourceText.trim().toLowerCase();
  return toNames.some((name) => {
    const normalizedName = name.trim().toLowerCase();
    return (
      normalizedName.length > 80 ||
      normalizedName === normalizedSource ||
      normalizedName.split(/\s+/).length > 4
    );
  });
}

function parseAvailabilitySlotFromEmail(email: RecentEmailContext): {
  startAt: string;
  endAt: string;
  timezone: string;
} | null {
  const combined = `${email.subject} ${email.snippet}`.replace(/\s+/g, " ").trim();
  const dayMatch = combined.match(/\b(today|tomorrow)\b/i);
  const timeMatch = combined.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!dayMatch || !timeMatch) {
    return null;
  }

  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: getDefaultTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const base = new Date(
    `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}Z`,
  );

  if (dayMatch[1].toLowerCase() === "tomorrow") {
    base.setUTCDate(base.getUTCDate() + 1);
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? "0");
  const meridiem = timeMatch[3].toLowerCase();
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, "0");
  const day = String(base.getUTCDate()).padStart(2, "0");
  const timezone = getDefaultTimezone();
  const startAt =
    timezone === "Europe/London"
      ? `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+01:00`
      : `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
  const endAt = new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString();

  return {
    startAt,
    endAt,
    timezone,
  };
}

async function checkCalendarBusyAtSlot(
  accessToken: string,
  slot: { startAt: string; endAt: string },
): Promise<boolean> {
  const events = await listCalendarEvents(accessToken, slot.startAt, slot.endAt);
  return events.some((event) => {
    if (!event.startAt || !event.endAt || event.status === "cancelled") {
      return false;
    }

    const eventStart = new Date(event.startAt).getTime();
    const eventEnd = new Date(event.endAt).getTime();
    const targetStart = new Date(slot.startAt).getTime();
    const targetEnd = new Date(slot.endAt).getTime();
    return eventStart < targetEnd && eventEnd > targetStart;
  });
}

function formatSlotForUser(startAt: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startAt));
}

function isCalendarInviteEmail(email: RecentEmailContext | null): boolean {
  if (!email) {
    return false;
  }

  return /^Invitation:/i.test(email.subject);
}

function parseInvitePayload(email: RecentEmailContext): CalendarInvitePayload | null {
  const subjectMatch = email.subject.match(
    /^Invitation:\s*(.*?)\s*@\s*[A-Za-z]{3}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\(([^)]+)\)/i,
  );
  if (!subjectMatch) {
    return null;
  }

  const [, rawTitle, day, month, year, startTime, endTime, timezoneLabel] = subjectMatch;
  const monthIndex = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(month.toLowerCase());
  if (monthIndex === -1) {
    return null;
  }

  const timezone = /\b(bst|gmt|united kingdom time)\b/i.test(timezoneLabel)
    ? "Europe/London"
    : getDefaultTimezone();
  const datePart = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;

  return {
    operation: "check_conflicts",
    title: rawTitle.trim() || "(No Subject)",
    startAt: `${datePart}T${startTime}:00`,
    endAt: `${datePart}T${endTime}:00`,
    timezone,
    organizerEmail: email.fromEmail,
  };
}

function detectInviteOperation(text: string): CalendarInvitePayload["operation"] | null {
  if (/\b(accept|approve|join)\b/i.test(text)) {
    return "accept";
  }
  if (/\b(decline|reject)\b/i.test(text)) {
    return "decline";
  }
  if (/\b(tentative|maybe)\b/i.test(text)) {
    return "tentative";
  }
  if (/\b(clash|clashes|conflict|conflicts|overlap|overlaps|free|available|double booked)\b/i.test(text)) {
    return "check_conflicts";
  }

  return null;
}

function buildInviteAction(
  sourceText: string,
  replyEmail: RecentEmailContext | null,
): AgentAction | null {
  if (!isCalendarInviteEmail(replyEmail) || !replyEmail) {
    return null;
  }

  const payload = parseInvitePayload(replyEmail);
  const operation = detectInviteOperation(sourceText);
  if (!payload || !operation) {
    return null;
  }

  payload.operation = operation;
  return {
    actionType: "manage_calendar_invite",
    status: operation === "check_conflicts" ? "completed" : "needs_confirmation",
    confidence: 0.95,
    requiresClarification: false,
    clarificationQuestion: null,
    payload,
    userVisibleSummary:
      operation === "check_conflicts"
        ? `Check for conflicts with "${payload.title}" at ${payload.startAt}.`
        : `Prepare to ${operation} the invite "${payload.title}".`,
    warnings: [],
  };
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
    case "manage_calendar_invite": {
      const payload = record.action.payload as CalendarInvitePayload;
      const inspection = await inspectCalendarInvite(accessToken, payload);
      if (!inspection.matchedEventId) {
        return "I could not find that calendar invite in your Google Calendar.";
      }

      if (payload.operation === "accept") {
        await updateCalendarInviteResponse(accessToken, inspection.matchedEventId, "accepted");
        return "Calendar invite accepted.";
      }
      if (payload.operation === "decline") {
        await updateCalendarInviteResponse(accessToken, inspection.matchedEventId, "declined");
        return "Calendar invite declined.";
      }
      if (payload.operation === "tentative") {
        await updateCalendarInviteResponse(accessToken, inspection.matchedEventId, "tentative");
        return "Calendar invite marked tentative.";
      }

      return inspection.conflicts.length === 0
        ? "No clashes found for that invite."
        : [
            "Clashes found:",
            ...inspection.conflicts.map((event) => `- ${event.title} at ${event.startAt ?? "unknown time"}`),
          ].join("\n");
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
    await sendBotMessage(chatId, "Cancelled.", { userId });
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
  await sendBotMessage(chatId, resultMessage, { userId: pending.telegramUserId });
  return true;
}

async function maybeHandlePendingClarification(
  requestText: string | null,
  userId: number,
  chatId: number,
  username: string | null,
  accessToken: string,
): Promise<boolean> {
  const normalized = requestText?.trim() ?? "";
  if (!normalized) {
    return false;
  }

  const pending = await getJson<PendingClarificationRecord>(PENDING_CLARIFICATION_KEY(userId));
  if (!pending) {
    return false;
  }

  if (!looksLikeRecipientClarification(normalized)) {
    await deleteKey(PENDING_CLARIFICATION_KEY(userId));
    return false;
  }

  if (/^(cancel|no|stop)$/i.test(normalized)) {
    await deleteKey(PENDING_CLARIFICATION_KEY(userId));
    await appendConversationTurn(userId, "assistant", "Cancelled.");
    await sendBotMessage(chatId, "Cancelled.", { userId, username });
    return true;
  }

  if (pending.clarificationType !== "gmail_recipient") {
    return false;
  }

  const payload = pending.action.payload as GmailDraftPayload;
  const resolved = await resolveContacts(accessToken, [normalized]);
  if (resolved.warning) {
    const replyText = `${resolved.warning}\nWho should I send this email to instead?`;
    await appendConversationTurn(userId, "assistant", replyText);
    await sendBotMessage(chatId, replyText, { userId, username });
    return true;
  }

  payload.toNames = [normalized];
  payload.to = resolved.matches;
  pending.action.payload = payload;
  pending.action.status = "needs_confirmation";
  pending.action.requiresClarification = false;
  pending.action.clarificationQuestion = null;

  await deleteKey(PENDING_CLARIFICATION_KEY(userId));
  const summary = summarizeAction(pending.action);
  await appendConversationTurn(userId, "assistant", summary);
  const sent = await sendBotMessage(chatId, summary, {
    replyMarkup: actionReplyMarkup(),
    userId,
    username,
  });
  await setJson(
    PENDING_ACTION_KEY(userId),
    {
      telegramUserId: userId,
      chatId,
      messageId: sent.message_id,
      action: pending.action,
      sourceText: pending.sourceText,
    } satisfies PendingActionRecord,
    60 * 30,
  );
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
      await sendBotMessage(chatId, "I could not transcribe that voice note.", {
        userId,
        username: request.username,
      });
      return;
    }
    await sendBotMessage(chatId, `Transcribed: ${sourceText}`, {
      userId,
      username: request.username,
    });
  }

  if (!sourceText.trim()) {
    await sendBotMessage(chatId, "Send a text or voice message with a request.", {
      userId,
      username: request.username,
    });
    return;
  }

  const handledClarification = await maybeHandlePendingClarification(
    sourceText,
    userId,
    chatId,
    request.username,
    accessToken,
  );
  if (handledClarification) {
    await appendConversationTurn(userId, "user", sourceText);
    return;
  }

  const conversation = await appendConversationTurn(userId, "user", sourceText);
  const replyEmail = await getReplyEmailContext(userId, request.replyToMessageId);
  const recentEmail = replyEmail ?? (await getRecentEmailContext(userId));
  if (replyEmail && !isCalendarInviteEmail(replyEmail) && isEmailReplyCheckIntent(sourceText)) {
    const slot = parseAvailabilitySlotFromEmail(replyEmail);
    if (!slot) {
      const replyText = "I found the email you mean, but I could not determine the requested time from it.";
      await appendConversationTurn(userId, "assistant", replyText);
      await sendBotMessage(chatId, replyText, {
        userId,
        username: request.username,
      });
      return;
    }

    const isBusy = await checkCalendarBusyAtSlot(accessToken, slot);
    const replyText = isBusy
      ? `You are busy at ${formatSlotForUser(slot.startAt, slot.timezone)}.`
      : `You are free at ${formatSlotForUser(slot.startAt, slot.timezone)}.`;
    await appendConversationTurn(userId, "assistant", replyText);
    await sendBotMessage(chatId, replyText, {
      userId,
      username: request.username,
    });
    return;
  }

  if (
    replyEmail &&
    !isCalendarInviteEmail(replyEmail) &&
    replyEmail.fromEmail &&
    looksLikeDirectReplyBody(sourceText)
  ) {
    const action: AgentAction = {
      actionType: "create_gmail_draft",
      status: "needs_confirmation",
      confidence: 0.95,
      requiresClarification: false,
      clarificationQuestion: null,
      payload: {
        toNames: [],
        to: [{ displayName: replyEmail.from, email: replyEmail.fromEmail }],
        subject: replyEmail.subject.startsWith("Re:")
          ? replyEmail.subject
          : `Re: ${replyEmail.subject}`,
        bodyText: sourceText,
        replyContextMessageId: replyEmail.messageId,
        threadId: replyEmail.threadId ?? null,
      } satisfies GmailDraftPayload,
      userVisibleSummary: `Prepare a reply to send: ${replyEmail.subject}.`,
      warnings: [],
    };
    const summary = summarizeAction(action);
    await appendConversationTurn(userId, "assistant", summary);
    const sent = await sendBotMessage(chatId, summary, {
      replyMarkup: actionReplyMarkup(),
      userId,
      username: request.username,
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
    return;
  }

  const action =
    buildInviteAction(sourceText, replyEmail) ??
    (await runPocketSecretary(
      request,
      sourceText,
      conversation.turns,
      recentEmail,
    ));

  if (action.requiresClarification || action.status === "requires_clarification") {
    const replyText = action.clarificationQuestion ?? action.userVisibleSummary;
    await appendConversationTurn(userId, "assistant", replyText);
    await sendBotMessage(chatId, replyText, {
      userId,
      username: request.username,
    });
    return;
  }

  if (action.actionType === "unsupported_request" || !action.payload) {
    await appendConversationTurn(userId, "assistant", action.userVisibleSummary);
    await sendBotMessage(chatId, action.userVisibleSummary, {
      userId,
      username: request.username,
    });
    return;
  }

  if (action.actionType === "manage_calendar_invite") {
    const payload = action.payload as CalendarInvitePayload;
    if (payload.operation === "check_conflicts") {
      const resultMessage = await executePendingAction({
        telegramUserId: userId,
        chatId,
        messageId: null,
        action,
        sourceText,
      });
      await appendConversationTurn(userId, "assistant", resultMessage);
      await sendBotMessage(chatId, resultMessage, {
        userId,
        username: request.username,
      });
      return;
    }
  }

  if (action.actionType === "create_calendar_event") {
    const payload = action.payload as CalendarEventPayload;
    const resolved = await resolveContacts(accessToken, payload.attendeeNames);
    if (resolved.warning) {
      await appendConversationTurn(userId, "assistant", resolved.warning);
      await sendBotMessage(chatId, resolved.warning, {
        userId,
        username: request.username,
      });
      return;
    }
    payload.attendees = resolved.matches;
    payload.timezone = payload.timezone || getDefaultTimezone();
  }

  if (action.actionType === "create_gmail_draft") {
    const payload = action.payload as GmailDraftPayload;
    const inferredRecipients = inferRecipientNamesFromEmailRequest(sourceText);
    if (
      payload.to.length === 0 &&
      inferredRecipients.length > 0 &&
      isSuspiciousRecipientExtraction(payload.toNames, sourceText)
    ) {
      payload.toNames = inferredRecipients;
    }

    if (payload.to.length === 0) {
      const resolved = await resolveContacts(accessToken, payload.toNames);
      if (resolved.warning) {
        const clarificationText = `${resolved.warning}\nWho should I send this email to instead?`;
        await setJson(
          PENDING_CLARIFICATION_KEY(userId),
          {
            telegramUserId: userId,
            chatId,
            action,
            sourceText,
            clarificationType: "gmail_recipient",
          } satisfies PendingClarificationRecord,
          60 * 30,
        );
        await appendConversationTurn(userId, "assistant", clarificationText);
        await sendBotMessage(chatId, clarificationText, {
          userId,
          username: request.username,
        });
        return;
      }
      payload.to = resolved.matches;
    }
  }

  const summary = summarizeAction(action);
  await appendConversationTurn(userId, "assistant", summary);
  const sent = await sendBotMessage(chatId, summary, {
    replyMarkup: actionReplyMarkup(),
    userId,
    username: request.username,
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

  const rawText = request.text?.trim() ?? "";
  const text = rawText.toLowerCase();
  if (text === "/start" || text === "/connect" || text === "connect google") {
    await sendConnectPrompt(request.chatId, request.userId, request.username);
    return { ok: true };
  }

  const googleAccessToken = await getValidGoogleAccessToken(request.userId);
  if (!googleAccessToken) {
    await sendConnectPrompt(request.chatId, request.userId, request.username);
    return { ok: true };
  }

  if (text === "/status" || text === "status") {
    const email = await getGoogleEmail(googleAccessToken);
    await sendReconnectStatus(
      request.chatId,
      request.userId,
      request.username,
      email,
    );
    return { ok: true };
  }

  if (text === "help") {
    await sendBotMessage(
      request.chatId,
      [
        "Send a text or voice message describing what you want.",
        "Reply to an email notification to draft a reply to that sender.",
        "Use Connect Google to link your account and Status to check it.",
      ].join("\n"),
      {
        userId: request.userId,
        username: request.username,
      },
    );
    return { ok: true };
  }

  await processConnectedRequest(update, request.chatId, request.userId);
  return { ok: true };
}
