import { getDefaultTimezone } from "@/src/lib/env";
import { extractActionFromText } from "@/src/lib/openai";
import type {
  AgentAction,
  CalendarEventPayload,
  CalendarInvitePayload,
  ConversationTurn,
  GmailDraftPayload,
  GoogleDocPayload,
  NormalizedBotRequest,
  RecentEmailContext,
} from "@/src/types";

function looksLikeReminder(text: string): boolean {
  return /\b(remind me|reminder|todo|to-do|task|don't let me forget|remember to)\b/i.test(
    text,
  );
}

function deriveReminderTitle(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^(please\s+)?(set\s+)?(a\s+)?reminder\s+(to\s+)?/i, "");
  cleaned = cleaned.replace(/^(please\s+)?remind me\s+(to\s+)?/i, "");
  cleaned = cleaned.replace(/\b(tomorrow|today|tonight|next\s+\w+|at\s+\d.*)$/i, "");
  cleaned = cleaned.trim().replace(/[.?!]+$/, "");

  if (!cleaned) {
    return "Reminder";
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function looksLikeReplyIntent(text: string): boolean {
  return /\b(reply|respond)(\s+to)?\s+(it|this|that|email|message)\b/i.test(text);
}

function stripReplyLeadIn(text: string): string {
  return text
    .replace(/^(please\s+)?(reply|respond)(\s+to)?\s+(it|this|that|email|message)\s*(and\s+say|saying|to\s+say)?\s*/i, "")
    .trim();
}

function isCalendarInviteEmail(email: RecentEmailContext | null): boolean {
  if (!email) {
    return false;
  }

  return (
    /^Invitation:/i.test(email.subject) ||
    /\byou have been invited\b/i.test(email.snippet) ||
    /\bjoin with google meet\b/i.test(email.snippet)
  );
}

function normalizeInviteTitle(value: string): string {
  const title = value.trim() || "(No Subject)";
  return title === "No Subject" ? "(No Subject)" : title;
}

function parseInviteDetails(email: RecentEmailContext): CalendarInvitePayload | null {
  const subjectMatch = email.subject.match(/^Invitation:\s*(.*?)\s*@\s*.+$/i);
  const title = normalizeInviteTitle(subjectMatch?.[1] ?? "(No Subject)");

  const snippetMatch = email.snippet.match(
    /on\s+[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s*[⋅·]\s*(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*\(([^)]+)\)/i,
  );
  const subjectTimeMatch = email.subject.match(
    /@\s*[A-Za-z]{3}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\(([^)]+)\)/i,
  );
  const match = snippetMatch ?? subjectTimeMatch;
  if (!match) {
    return null;
  }

  const [, day, month, year, startTime, endTime, timezoneLabel] = match;
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

  const timezone = /\b(united kingdom time|bst|gmt)\b/i.test(timezoneLabel)
    ? "Europe/London"
    : getDefaultTimezone();
  const datePart = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;

  return {
    operation: "check_conflicts",
    title,
    startAt: `${datePart}T${startTime}:00`,
    endAt: `${datePart}T${endTime}:00`,
    timezone,
    organizerEmail: email.fromEmail,
  };
}

function getInviteOperation(text: string): CalendarInvitePayload["operation"] | null {
  if (/\b(check|see|tell me).*\b(clash|conflict|double booked|overlap)\b/i.test(text)) {
    return "check_conflicts";
  }
  if (/\baccept\b/i.test(text)) {
    return "accept";
  }
  if (/\bdecline\b/i.test(text)) {
    return "decline";
  }
  if (/\b(tentative|maybe)\b/i.test(text)) {
    return "tentative";
  }

  return null;
}

export async function runPocketSecretary(
  request: NormalizedBotRequest,
  sourceText: string,
  conversation: ConversationTurn[],
  recentEmail: RecentEmailContext | null,
): Promise<AgentAction> {
  const extracted = await extractActionFromText(sourceText, conversation, recentEmail);
  const reminderFallback = looksLikeReminder(sourceText);
  const hasReplyContext =
    recentEmail !== null &&
    (request.replyToMessageId !== null || looksLikeReplyIntent(sourceText));
  const inviteDetails =
    hasReplyContext && isCalendarInviteEmail(recentEmail) && recentEmail
      ? parseInviteDetails(recentEmail)
      : null;
  const inviteOperation = inviteDetails ? getInviteOperation(sourceText) : null;

  if (reminderFallback && extracted.actionType === "unsupported_request") {
    extracted.actionType = "create_calendar_event";
    extracted.confidence = Math.max(extracted.confidence, 0.55);
    extracted.calendar = {
      title: deriveReminderTitle(sourceText),
      startAt: null,
      endAt: null,
      timezone: getDefaultTimezone(),
      attendeeNames: [],
      description: "Reminder created by Pocket Secretary.",
    };
  }

  if (hasReplyContext && extracted.actionType === "unsupported_request" && recentEmail) {
    const replyBody = stripReplyLeadIn(sourceText);
    extracted.actionType = "create_gmail_draft";
    extracted.confidence = Math.max(extracted.confidence, 0.6);
    extracted.gmail = {
      toNames: [],
      subject: recentEmail.subject.startsWith("Re:")
        ? recentEmail.subject
        : `Re: ${recentEmail.subject}`,
      bodyText: replyBody || "",
    };
  }

  if (inviteDetails && inviteOperation) {
    const payload: CalendarInvitePayload = {
      ...inviteDetails,
      operation: inviteOperation,
    };

    return {
      actionType: "manage_calendar_invite",
      status: inviteOperation === "check_conflicts" ? "completed" : "needs_confirmation",
      confidence: Math.max(extracted.confidence, 0.7),
      requiresClarification: false,
      clarificationQuestion: null,
      payload,
      userVisibleSummary:
        inviteOperation === "check_conflicts"
          ? `Check for conflicts with "${payload.title}" at ${payload.startAt}.`
          : `Prepare to ${inviteOperation} the invite "${payload.title}".`,
      warnings: [],
    };
  }

  if (
    extracted.actionType === "clarify_request" ||
    extracted.clarificationQuestion
  ) {
    return {
      actionType: "clarify_request",
      status: "requires_clarification",
      confidence: extracted.confidence,
      requiresClarification: true,
      clarificationQuestion:
        extracted.clarificationQuestion ?? "I need a bit more detail to do that.",
      payload: null,
      userVisibleSummary: "More detail is needed before I can continue.",
      warnings: [],
    };
  }

  if (extracted.actionType === "create_calendar_event" && extracted.calendar) {
    const payload: CalendarEventPayload = {
      title: extracted.calendar.title ?? "Untitled event",
      startAt: extracted.calendar.startAt,
      endAt: extracted.calendar.endAt,
      timezone: extracted.calendar.timezone ?? getDefaultTimezone(),
      attendeeNames: extracted.calendar.attendeeNames,
      attendees: [],
      description:
        extracted.calendar.description ?? "Created by Pocket Secretary.",
    };

    if (!payload.startAt) {
      return {
        actionType: "clarify_request",
        status: "requires_clarification",
        confidence: extracted.confidence,
        requiresClarification: true,
        clarificationQuestion:
          reminderFallback
            ? "What date and time should I use for the reminder?"
            : "What date and time should I use for the calendar event?",
        payload: null,
        userVisibleSummary: reminderFallback
          ? "Reminder needs a date and time."
          : "Calendar request needs a date and time.",
        warnings: [],
      };
    }

    return {
      actionType: "create_calendar_event",
      status: "needs_confirmation",
      confidence: extracted.confidence,
      requiresClarification: false,
      clarificationQuestion: null,
      payload,
      userVisibleSummary: reminderFallback
        ? `Prepare a reminder: ${payload.title}.`
        : `Prepare a calendar event: ${payload.title}.`,
      warnings: [],
    };
  }

  if (extracted.actionType === "create_gmail_draft" && extracted.gmail) {
    const payload: GmailDraftPayload = {
      toNames: extracted.gmail.toNames,
      to:
        hasReplyContext && recentEmail?.fromEmail
          ? [
              {
                displayName: recentEmail.from,
                email: recentEmail.fromEmail,
              },
            ]
          : [],
      subject: extracted.gmail.subject ?? "Draft from Pocket Secretary",
      bodyText: extracted.gmail.bodyText ?? sourceText,
      replyContextMessageId: hasReplyContext && recentEmail ? recentEmail.messageId : null,
    };

    if (payload.toNames.length === 0 && payload.to.length === 0) {
      return {
        actionType: "clarify_request",
        status: "requires_clarification",
        confidence: extracted.confidence,
        requiresClarification: true,
        clarificationQuestion: hasReplyContext
          ? "I know which email you mean, but what should the reply say?"
          : "Who should I address this email to?",
        payload: null,
        userVisibleSummary: hasReplyContext
          ? "Reply needs message content."
          : "Email request needs a recipient.",
        warnings: [],
      };
    }

    if (hasReplyContext && recentEmail && payload.to.length > 0 && !payload.bodyText.trim()) {
      return {
        actionType: "clarify_request",
        status: "requires_clarification",
        confidence: extracted.confidence,
        requiresClarification: true,
        clarificationQuestion: `What should I say in the reply to "${recentEmail.subject}"?`,
        payload: null,
        userVisibleSummary: "Reply needs message content.",
        warnings: [],
      };
    }

    return {
      actionType: "create_gmail_draft",
      status: "needs_confirmation",
      confidence: extracted.confidence,
      requiresClarification: false,
      clarificationQuestion: null,
      payload,
      userVisibleSummary: hasReplyContext
        ? `Prepare a reply to send: ${payload.subject}.`
        : `Prepare an email to send: ${payload.subject}.`,
      warnings: [],
    };
  }

  if (extracted.actionType === "create_google_doc" && extracted.doc) {
    const payload: GoogleDocPayload = {
      title: extracted.doc.title ?? "Notes from Pocket Secretary",
      content: extracted.doc.content ?? sourceText,
    };

    return {
      actionType: "create_google_doc",
      status: "needs_confirmation",
      confidence: extracted.confidence,
      requiresClarification: false,
      clarificationQuestion: null,
      payload,
      userVisibleSummary: `Prepare a Google Doc: ${payload.title}.`,
      warnings: [],
    };
  }

  return {
    actionType: "unsupported_request",
    status: "completed",
    confidence: extracted.confidence,
    requiresClarification: false,
    clarificationQuestion: null,
    payload: null,
    userVisibleSummary:
      request.messageType === "voice"
        ? "I understood the voice note, but I could not map it to calendar, email, or notes."
        : "I could not map that request to calendar, email, or notes.",
    warnings: [],
  };
}
