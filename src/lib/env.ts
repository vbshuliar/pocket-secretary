function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function getAppUrl(): string {
  return optional("APP_URL", "http://localhost:3000");
}

export function getDefaultTimezone(): string {
  return optional("DEFAULT_TIMEZONE", "Europe/London");
}

export function getSessionSecret(): string {
  return required("SESSION_SECRET");
}

export function getTelegramBotToken(): string {
  return required("TELEGRAM_BOT_TOKEN");
}

export function getTelegramBotUsername(): string {
  return optional("TELEGRAM_BOT_USERNAME");
}

export function getTelegramWebhookSecret(): string {
  return optional("TELEGRAM_WEBHOOK_SECRET");
}

export function getConnectTokenTtlSeconds(): number {
  return Number(optional("TELEGRAM_CONNECT_TOKEN_TTL_SECONDS", "900"));
}

export function getOpenAIKey(): string {
  return required("OPENAI_API_KEY");
}

export function getOpenAIModel(): string {
  return optional("OPENAI_MODEL", "gpt-5-mini");
}

export function getOpenAITranscriptionModel(): string {
  return optional("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe");
}

export function getUpstashUrl(): string {
  return required("UPSTASH_REDIS_REST_URL").replace(/^"(.*)"$/, "$1");
}

export function getUpstashToken(): string {
  return required("UPSTASH_REDIS_REST_TOKEN").replace(/^"(.*)"$/, "$1");
}

export function getUpstashKeyPrefix(): string {
  return optional("UPSTASH_REDIS_KEY_PREFIX", "pocket-secretary");
}

export function getGoogleClientId(): string {
  return required("GOOGLE_CLIENT_ID");
}

export function getGoogleClientSecret(): string {
  return required("GOOGLE_CLIENT_SECRET");
}

export function getGoogleRedirectUri(): string {
  return required("GOOGLE_REDIRECT_URI");
}

export function getGoogleOAuthScopes(): string[] {
  return required("GOOGLE_OAUTH_SCOPES")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function getGoogleTokenEncryptionKey(): string {
  return required("GOOGLE_TOKEN_ENCRYPTION_KEY");
}

export function getGoogleDefaultCalendarId(): string {
  return optional("GOOGLE_DEFAULT_CALENDAR_ID", "primary");
}
