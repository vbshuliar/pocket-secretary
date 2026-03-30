import { createConnectUrlForUser } from "@/src/bot/process-update";
import {
  listCalendarEvents,
  getGoogleEmail,
  getLinkedTelegramUserIds,
  getValidGoogleAccessToken,
  listRecentInboxMessages,
  sendGmailMessage,
} from "@/src/lib/google-workspace";
import { getDefaultTimezone } from "@/src/lib/env";
import { botMenuReplyMarkup, sendTelegramMessage } from "@/src/lib/telegram-api";
import { getJson, setJson } from "@/src/lib/upstash";
import type { RecentEmailContext } from "@/src/types";

type InboxCursor = {
  latestInternalDate: number;
  seenMessageIds: string[];
};

const INBOX_CURSOR_KEY = (telegramUserId: number) => `gmail:cursor:${telegramUserId}`;
const RECENT_EMAIL_KEY = (telegramUserId: number) => `recent-email:${telegramUserId}`;
const TELEGRAM_EMAIL_CONTEXT_KEY = (telegramUserId: number, messageId: number) =>
  `telegram-email-context:${telegramUserId}:${messageId}`;
const AUTONOMOUS_BUFFER_MINUTES = 10;

function parseEmailAddress(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim();
  }

  const plainMatch = from.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return plainMatch?.[0] ?? null;
}

function summarizeEmail(from: string, subject: string, snippet: string): string {
  const compactSnippet = snippet.trim().replace(/\s+/g, " ");
  return [
    "New email",
    `From: ${from}`,
    `Subject: ${subject}`,
    "Body preview:",
    compactSnippet || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isCalendarInviteSubject(subject: string): boolean {
  return /^Invitation:/i.test(subject);
}

function isSimpleAvailabilityQuestion(text: string): boolean {
  return /\b(are you available|are you free|available|free|can you do|can we do|does .* work|would .* work|does that work|is that okay|works for you|work for you)\b/i.test(
    text,
  );
}

function hasSchedulingSignal(text: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(
    text,
  );
}

function parseDurationMinutes(text: string): number {
  const match = text.match(/\bfor\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  if (!match) {
    return 30;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 30;
  }

  return /hour|hr/i.test(match[2]) ? amount * 60 : amount;
}

function parseTimeParts(value: string): { hour: number; minute: number } | null {
  const match = value.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase() ?? null;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) {
    return null;
  }

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

function londonNow(): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: getDefaultTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return new Date(
    `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}Z`,
  );
}

function nextWeekday(base: Date, weekday: number): Date {
  const candidate = new Date(base);
  const current = candidate.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  candidate.setUTCDate(candidate.getUTCDate() + delta);
  return candidate;
}

function parseRequestedDate(text: string): Date | null {
  const base = londonNow();
  if (/\btomorrow\b/i.test(text)) {
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (/\btoday\b/i.test(text)) {
    return base;
  }

  const weekdayMatch = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (!weekdayMatch) {
    return null;
  }

  const weekdayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return nextWeekday(base, weekdayMap[weekdayMatch[1].toLowerCase()]);
}

function parseRequestedTime(text: string): { hour: number; minute: number } | null {
  const pattern =
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+\w+){0,4}?\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
  const direct = text.match(pattern);
  if (direct?.[1]) {
    return parseTimeParts(direct[1]);
  }

  const fallback = text.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  return fallback?.[1] ? parseTimeParts(fallback[1]) : null;
}

function timezoneOffsetString(timezone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    year: "numeric",
  }).formatToParts(date);
  const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = raw.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    return "+00:00";
  }

  const [, sign, hours, minutes] = match;
  return `${sign}${hours.padStart(2, "0")}:${(minutes ?? "00").padStart(2, "0")}`;
}

function buildZonedIso(localDate: Date, hour: number, minute: number, timezone: string): string {
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localDate.getUTCDate()).padStart(2, "0");
  const naive = `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const offset = timezoneOffsetString(timezone, new Date(`${naive}Z`));
  return `${naive}${offset}`;
}

function formatRequestedSlot(startAt: string, timezone: string): string {
  const date = new Date(startAt);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function buildAutonomousReplyBody(isFree: boolean, startAt: string, timezone: string): string {
  const slot = formatRequestedSlot(startAt, timezone);
  return isFree
    ? `Yes, ${slot} works for me.`
    : `I'm not available at ${slot}.`;
}

function detectAutonomousAvailabilityRequest(message: {
  subject: string;
  snippet: string;
  from: string;
  threadId?: string;
}): {
  startAt: string;
  endAt: string;
  timezone: string;
} | null {
  if (isCalendarInviteSubject(message.subject)) {
    return null;
  }

  const combined = normalizeSpaces(`${message.subject} ${message.snippet}`);
  if (!isSimpleAvailabilityQuestion(combined) || !hasSchedulingSignal(combined)) {
    return null;
  }

  const requestedDate = parseRequestedDate(combined);
  const requestedTime = parseRequestedTime(combined);
  if (!requestedDate || !requestedTime) {
    return null;
  }

  const timezone = getDefaultTimezone();
  const durationMinutes = parseDurationMinutes(combined);
  const startAt = buildZonedIso(requestedDate, requestedTime.hour, requestedTime.minute, timezone);
  const endDate = new Date(new Date(startAt).getTime() + durationMinutes * 60_000);
  const endAt = endDate.toISOString();

  return {
    startAt,
    endAt,
    timezone,
  };
}

async function hasCalendarConflict(
  accessToken: string,
  startAt: string,
  endAt: string,
): Promise<boolean> {
  const bufferedStart = new Date(new Date(startAt).getTime() - AUTONOMOUS_BUFFER_MINUTES * 60_000);
  const bufferedEnd = new Date(new Date(endAt).getTime() + AUTONOMOUS_BUFFER_MINUTES * 60_000);
  const events = await listCalendarEvents(
    accessToken,
    bufferedStart.toISOString(),
    bufferedEnd.toISOString(),
  );

  return events.some((event) => {
    if (!event.startAt || !event.endAt || event.status === "cancelled") {
      return false;
    }

    const eventStart = new Date(event.startAt).getTime();
    const eventEnd = new Date(event.endAt).getTime();
    return eventStart < bufferedEnd.getTime() && eventEnd > bufferedStart.getTime();
  });
}

async function maybeAutonomouslyReplyToSchedulingEmail(
  accessToken: string,
  message: {
    subject: string;
    snippet: string;
    from: string;
    fromEmail: string | null;
    threadId?: string;
    messageHeaderId: string | null;
    referencesHeader: string | null;
  },
): Promise<{
  replyText: string;
  hadConflict: boolean;
  checkedStartAt: string;
  checkedEndAt: string;
  timezone: string;
} | null> {
  if (!message.fromEmail) {
    return null;
  }

  const request = detectAutonomousAvailabilityRequest(message);
  if (!request) {
    return null;
  }

  const hasConflict = await hasCalendarConflict(accessToken, request.startAt, request.endAt);
  const bodyText = buildAutonomousReplyBody(!hasConflict, request.startAt, request.timezone);
  const referencesHeader = [message.referencesHeader, message.messageHeaderId]
    .filter(Boolean)
    .join(" ")
    .trim();

  await sendGmailMessage(accessToken, {
    toNames: [],
    to: [{ displayName: message.from, email: message.fromEmail }],
    subject: message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`,
    bodyText,
    threadId: message.threadId ?? null,
    inReplyToMessageHeader: message.messageHeaderId,
    referencesHeader: referencesHeader || null,
  });

  return {
    replyText: bodyText,
    hadConflict: hasConflict,
    checkedStartAt: request.startAt,
    checkedEndAt: request.endAt,
    timezone: request.timezone,
  };
}

export async function checkInboxNotifications(): Promise<{
  checkedUsers: number;
  notifiedMessages: number;
}> {
  const userIds = await getLinkedTelegramUserIds();
  let notifiedMessages = 0;

  for (const userId of userIds) {
    const accessToken = await getValidGoogleAccessToken(userId);
    if (!accessToken) {
      continue;
    }

    const email = await getGoogleEmail(accessToken);
    const messages = await listRecentInboxMessages(accessToken, 8);
    if (messages.length === 0) {
      continue;
    }

    const cursor =
      (await getJson<InboxCursor>(INBOX_CURSOR_KEY(userId))) ?? null;
    const latestInternalDate = messages[0].internalDate;

    if (!cursor) {
      await setJson(INBOX_CURSOR_KEY(userId), {
        latestInternalDate,
        seenMessageIds: messages.map((message) => message.id).slice(0, 20),
      } satisfies InboxCursor);
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
      const connectUrl = await createConnectUrlForUser(userId, userId, null);
      const context: RecentEmailContext = {
        messageId: message.id,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        fromEmail: parseEmailAddress(message.from),
        snippet: message.snippet,
        timestamp: message.internalDate,
      };
      const autonomousReply = await maybeAutonomouslyReplyToSchedulingEmail(accessToken, {
        subject: message.subject,
        snippet: message.snippet,
        from: message.from,
        fromEmail: context.fromEmail,
        threadId: message.threadId,
        messageHeaderId: message.messageHeaderId,
        referencesHeader: message.referencesHeader,
      });
      const sent = await sendTelegramMessage(
        userId,
        autonomousReply
          ? [
              "Email received and handled automatically",
              `From: ${message.from}`,
              `Subject: ${message.subject}`,
              `Calendar check: ${autonomousReply.hadConflict ? "busy at requested time" : "free at requested time"}`,
              `Checked slot: ${formatRequestedSlot(autonomousReply.checkedStartAt, autonomousReply.timezone)}`,
              "Reply sent:",
              autonomousReply.replyText,
              ...(email ? [`Account: ${email}`] : []),
            ].join("\n")
          : `${summarizeEmail(message.from, message.subject, message.snippet)}${email ? `\nAccount: ${email}` : ""}`,
        {
          replyMarkup: botMenuReplyMarkup(connectUrl),
        },
      );
      await setJson(RECENT_EMAIL_KEY(userId), context, 60 * 60 * 24 * 7);
      await setJson(
        TELEGRAM_EMAIL_CONTEXT_KEY(userId, sent.message_id),
        context,
        60 * 60 * 24 * 7,
      );
      notifiedMessages += 1;
    }

    await setJson(INBOX_CURSOR_KEY(userId), {
      latestInternalDate: Math.max(cursor.latestInternalDate, latestInternalDate),
      seenMessageIds: messages.map((message) => message.id).slice(0, 20),
    } satisfies InboxCursor);
  }

  return {
    checkedUsers: userIds.length,
    notifiedMessages,
  };
}
