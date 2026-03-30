import {
  getGoogleEmail,
  getLinkedTelegramUserIds,
  getValidGoogleAccessToken,
  listRecentInboxMessages,
} from "@/src/lib/google-workspace";
import { sendTelegramMessage } from "@/src/lib/telegram-api";
import { getJson, setJson } from "@/src/lib/upstash";

type InboxCursor = {
  latestInternalDate: number;
  seenMessageIds: string[];
};

const INBOX_CURSOR_KEY = (telegramUserId: number) => `gmail:cursor:${telegramUserId}`;

function summarizeEmail(from: string, subject: string, snippet: string): string {
  const compactSnippet = snippet.trim().replace(/\s+/g, " ").slice(0, 180);
  return [
    "New email",
    `From: ${from}`,
    `Subject: ${subject}`,
    compactSnippet ? `Preview: ${compactSnippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
      await sendTelegramMessage(
        userId,
        `${summarizeEmail(message.from, message.subject, message.snippet)}${email ? `\nAccount: ${email}` : ""}`,
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
