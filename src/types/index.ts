export type MessageType = "text" | "voice";

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramVoice {
  file_id: string;
}

export interface TelegramAudio {
  file_id: string;
}

export interface TelegramMessage {
  message_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface NormalizedBotRequest {
  updateId: number;
  chatId: number | null;
  userId: number | null;
  username: string | null;
  messageId: number | null;
  text: string | null;
  voiceFileId: string | null;
  messageType: MessageType;
  callbackQueryId: string | null;
  callbackData: string | null;
  raw: TelegramUpdate;
}

export type AgentActionType =
  | "create_calendar_event"
  | "create_gmail_draft"
  | "create_google_doc"
  | "clarify_request"
  | "unsupported_request";

export type AgentActionStatus =
  | "needs_confirmation"
  | "requires_clarification"
  | "completed";

export interface ContactMatch {
  displayName: string;
  email: string;
}

export interface CalendarEventPayload {
  title: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  attendeeNames: string[];
  attendees: ContactMatch[];
  description: string;
}

export interface GmailDraftPayload {
  toNames: string[];
  to: ContactMatch[];
  subject: string;
  bodyText: string;
  replyContextMessageId?: string | null;
}

export interface GoogleDocPayload {
  title: string;
  content: string;
}

export type AgentPayload =
  | CalendarEventPayload
  | GmailDraftPayload
  | GoogleDocPayload
  | null;

export interface AgentAction {
  actionType: AgentActionType;
  status: AgentActionStatus;
  confidence: number;
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  payload: AgentPayload;
  userVisibleSummary: string;
  warnings: string[];
}

export interface PendingActionRecord {
  telegramUserId: number;
  chatId: number;
  messageId: number | null;
  action: AgentAction;
  sourceText: string;
}

export interface OAuthStateRecord {
  connectToken: string;
  telegramUserId: number;
  chatId: number;
}

export interface ConnectTokenRecord {
  telegramUserId: number;
  chatId: number;
  username: string | null;
}

export interface GoogleTokenRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  email: string | null;
}

export interface OpenAIExtractionResult {
  actionType: AgentActionType;
  confidence: number;
  clarificationQuestion: string | null;
  calendar?: {
    title: string | null;
    startAt: string | null;
    endAt: string | null;
    timezone: string | null;
    attendeeNames: string[];
    description: string | null;
  };
  gmail?: {
    toNames: string[];
    subject: string | null;
    bodyText: string | null;
  };
  doc?: {
    title: string | null;
    content: string | null;
  };
}

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface ConversationState {
  turns: ConversationTurn[];
}

export interface RecentEmailContext {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  snippet: string;
  timestamp: number;
}
