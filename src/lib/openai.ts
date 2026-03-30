import { getDefaultTimezone, getOpenAIKey, getOpenAIModel, getOpenAITranscriptionModel } from "@/src/lib/env";
import type { ConversationTurn, OpenAIExtractionResult, RecentEmailContext } from "@/src/types";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getOpenAIKey()}`,
  };
}

export async function transcribeAudioFromUrl(audioUrl: string): Promise<string> {
  const audioResponse = await fetch(audioUrl, { cache: "no-store" });
  if (!audioResponse.ok) {
    throw new Error(`Failed to download Telegram audio: ${audioResponse.status}`);
  }

  const arrayBuffer = await audioResponse.arrayBuffer();
  const formData = new FormData();
  formData.append("model", getOpenAITranscriptionModel());
  formData.append(
    "file",
    new File([arrayBuffer], "telegram-audio.ogg", { type: "audio/ogg" }),
  );

  const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with status ${response.status}`);
  }

  const json = (await response.json()) as { text?: string };
  return json.text?.trim() ?? "";
}

function extractJsonCandidate(content: string): string {
  const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return content.trim();
}

export async function extractActionFromText(
  text: string,
  conversation: ConversationTurn[],
  recentEmail: RecentEmailContext | null,
): Promise<OpenAIExtractionResult> {
  const today = new Date().toISOString();
  const conversationContext = conversation
    .slice(-6)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  const recentEmailContext = recentEmail
    ? [
        `Recent notified email sender: ${recentEmail.from}`,
        `Recent notified email sender address: ${recentEmail.fromEmail ?? "unknown"}`,
        `Recent notified email subject: ${recentEmail.subject}`,
        `Recent notified email preview: ${recentEmail.snippet}`,
      ].join("\n")
    : "";
  const systemPrompt = [
    "You are Pocket Secretary.",
    "Return only strict JSON with this schema:",
    '{"actionType":"create_calendar_event|create_gmail_draft|create_google_doc|clarify_request|unsupported_request","confidence":0.0,"clarificationQuestion":null,"calendar":{"title":null,"startAt":null,"endAt":null,"timezone":null,"attendeeNames":[],"description":null},"gmail":{"toNames":[],"subject":null,"bodyText":null},"doc":{"title":null,"content":null}}',
    "If the user asks to schedule, use create_calendar_event.",
    "If the user asks for a reminder, remind me, to-do, or task with a time or day, use create_calendar_event.",
    "For reminder-style requests, create a calendar entry even if there are no attendees.",
    "If the user asks to email or write an email, use create_gmail_draft.",
    "If the user says reply to it, respond to it, reply to that email, or similar, and recent email context is available, use create_gmail_draft.",
    "If the user asks to save notes or create notes, use create_google_doc.",
    `Default timezone is ${getDefaultTimezone()}.`,
    `Current timestamp is ${today}.`,
    "Use prior conversation when the latest user message is a follow-up like 'move it to tomorrow' or 'send it to Alex instead'.",
    "Use ISO 8601 for datetimes when the user gives enough information. If the time is unclear, return actionType clarify_request.",
  ].join(" ");

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getOpenAIModel(),
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        ...(conversationContext
          ? [
              {
                role: "user" as const,
                content: `Recent conversation:\n${conversationContext}`,
              },
            ]
          : []),
        ...(recentEmailContext
          ? [
              {
                role: "user" as const,
                content: `Recent email context:\n${recentEmailContext}`,
              },
            ]
          : []),
        { role: "user", content: `Latest user request:\n${text}` },
      ],
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI extraction returned empty content");
  }

  return JSON.parse(extractJsonCandidate(content)) as OpenAIExtractionResult;
}
