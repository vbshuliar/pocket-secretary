import { getGoogleDefaultCalendarId } from "@/src/lib/env";
import { refreshGoogleAccessToken } from "@/src/lib/google-oauth";
import { decryptJson, encryptJson } from "@/src/lib/crypto";
import { addToSet, deleteKey, getSetMembers, getString, removeFromSet, setString } from "@/src/lib/upstash";
import type {
  CalendarEventPayload,
  ContactMatch,
  GmailDraftPayload,
  GoogleDocPayload,
  GoogleTokenRecord,
} from "@/src/types";

const TOKENS_KEY = (telegramUserId: number) => `google:tokens:${telegramUserId}`;
const LINKED_USERS_KEY = "google:linked-users";

async function fetchGoogleJson<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Google API request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function storeGoogleTokens(
  telegramUserId: number,
  tokenRecord: GoogleTokenRecord,
): Promise<void> {
  await setString(TOKENS_KEY(telegramUserId), encryptJson(tokenRecord));
  await addToSet(LINKED_USERS_KEY, String(telegramUserId));
}

export async function deleteGoogleTokens(telegramUserId: number): Promise<void> {
  await deleteKey(TOKENS_KEY(telegramUserId));
  await removeFromSet(LINKED_USERS_KEY, String(telegramUserId));
}

export async function getGoogleTokens(
  telegramUserId: number,
): Promise<GoogleTokenRecord | null> {
  const encrypted = await getString(TOKENS_KEY(telegramUserId));
  return encrypted ? decryptJson<GoogleTokenRecord>(encrypted) : null;
}

export async function getValidGoogleAccessToken(telegramUserId: number): Promise<string | null> {
  const tokens = await getGoogleTokens(telegramUserId);
  if (!tokens) {
    return null;
  }

  const expiresSoon = tokens.expiresAt ? tokens.expiresAt < Date.now() + 60_000 : false;
  if (!expiresSoon) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    return tokens.accessToken;
  }

  const refreshed = await refreshGoogleAccessToken(tokens.refreshToken);
  const updated: GoogleTokenRecord = {
    ...tokens,
    ...refreshed,
  };
  await storeGoogleTokens(telegramUserId, updated);

  return updated.accessToken;
}

export async function getGoogleEmail(accessToken: string): Promise<string | null> {
  const response = await fetchGoogleJson<{ emailAddress?: string }>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  );
  return response.emailAddress ?? null;
}

export async function getLinkedTelegramUserIds(): Promise<number[]> {
  const members = await getSetMembers(LINKED_USERS_KEY);
  return members
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

export async function searchGoogleContacts(
  accessToken: string,
  query: string,
): Promise<ContactMatch[]> {
  const params = new URLSearchParams({
    query,
    readMask: "names,emailAddresses",
    pageSize: "10",
  });
  const response = await fetchGoogleJson<{
    results?: Array<{
      person?: {
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
      };
    }>;
  }>(
    accessToken,
    `https://people.googleapis.com/v1/people:searchContacts?${params.toString()}`,
    { method: "GET" },
  );

  return (response.results ?? [])
    .map((result) => {
      const person = result.person;
      const email = person?.emailAddresses?.[0]?.value;
      const displayName = person?.names?.[0]?.displayName ?? query;
      if (!email) {
        return null;
      }

      return {
        displayName,
        email,
      };
    })
    .filter((value): value is ContactMatch => value !== null);
}

export async function createCalendarEvent(
  accessToken: string,
  payload: CalendarEventPayload,
): Promise<{ htmlLink?: string }> {
  return fetchGoogleJson(
    accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getGoogleDefaultCalendarId())}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: payload.title,
        description: payload.description,
        start: {
          dateTime: payload.startAt,
          timeZone: payload.timezone,
        },
        end: {
          dateTime: payload.endAt ?? payload.startAt,
          timeZone: payload.timezone,
        },
        attendees: payload.attendees.map((attendee) => ({
          email: attendee.email,
          displayName: attendee.displayName,
        })),
      }),
    },
  );
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawEmail(payload: GmailDraftPayload): string {
  return [
    `To: ${payload.to.map((recipient) => recipient.email).join(", ")}`,
    `Subject: ${payload.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    payload.bodyText,
  ].join("\r\n");
}

export async function createGmailDraft(
  accessToken: string,
  payload: GmailDraftPayload,
): Promise<{ id?: string; message?: { id?: string } }> {
  const raw = buildRawEmail(payload);

  return fetchGoogleJson(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      body: JSON.stringify({
        message: {
          raw: toBase64Url(raw),
        },
      }),
    },
  );
}

export async function sendGmailMessage(
  accessToken: string,
  payload: GmailDraftPayload,
): Promise<{ id?: string }> {
  const raw = buildRawEmail(payload);

  return fetchGoogleJson(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({
      raw: toBase64Url(raw),
    }),
  });
}

export async function createGoogleDoc(
  accessToken: string,
  payload: GoogleDocPayload,
): Promise<{ documentId?: string; title?: string }> {
  const created = await fetchGoogleJson<{ documentId?: string; title?: string }>(
    accessToken,
    "https://docs.googleapis.com/v1/documents",
    {
      method: "POST",
      body: JSON.stringify({
        title: payload.title,
      }),
    },
  );

  if (created.documentId && payload.content.trim()) {
    await fetchGoogleJson(
      accessToken,
      `https://docs.googleapis.com/v1/documents/${created.documentId}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: {
                  index: 1,
                },
                text: payload.content,
              },
            },
          ],
        }),
      },
    );
  }

  return created;
}

export interface GmailInboxMessage {
  id: string;
  threadId?: string;
  internalDate: number;
  subject: string;
  from: string;
  snippet: string;
}

export async function listRecentInboxMessages(
  accessToken: string,
  maxResults = 10,
): Promise<GmailInboxMessage[]> {
  const params = new URLSearchParams({
    labelIds: "INBOX",
    maxResults: String(maxResults),
    q: "category:primary OR category:updates OR is:unread newer_than:7d",
  });
  const listed = await fetchGoogleJson<{
    messages?: Array<{ id: string; threadId?: string }>;
  }>(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    { method: "GET" },
  );

  const messages = listed.messages ?? [];
  const results: GmailInboxMessage[] = [];

  for (const message of messages) {
    const full = await fetchGoogleJson<{
      id: string;
      threadId?: string;
      internalDate?: string;
      snippet?: string;
      payload?: {
        headers?: Array<{ name?: string; value?: string }>;
      };
    }>(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { method: "GET" },
    );

    const headers = full.payload?.headers ?? [];
    const subject = headers.find((header) => header.name === "Subject")?.value ?? "(no subject)";
    const from = headers.find((header) => header.name === "From")?.value ?? "(unknown sender)";
    results.push({
      id: full.id,
      threadId: full.threadId,
      internalDate: Number(full.internalDate ?? "0"),
      subject,
      from,
      snippet: full.snippet ?? "",
    });
  }

  return results.sort((a, b) => b.internalDate - a.internalDate);
}
