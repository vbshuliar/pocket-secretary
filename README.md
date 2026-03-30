# Pocket Secretary

Pocket Secretary turns Telegram messages into real work inside Google Workspace.

Send a text or voice note to the bot, connect your Google account once, and Pocket Secretary can turn that request into a calendar event, an email, a Google Doc, or an invite response. The repository is a small Next.js control plane around that workflow: Telegram ingestion, OpenAI-based extraction/transcription, Google OAuth, Google Workspace execution, and Upstash-backed short-lived state.

## What It Does

- Accepts Telegram text and voice messages
- Transcribes voice notes with OpenAI
- Extracts intent and action payloads from natural language
- Connects a Telegram user to a Google account through OAuth
- Creates Google Calendar events
- Sends Gmail messages and prepares email-style actions
- Creates Google Docs from notes
- Handles calendar invite follow-ups like conflict checks and RSVP actions
- Stores temporary confirmation, conversation, and linkage state in Upstash Redis

## Product Flow

1. A user messages the Telegram bot.
2. The app normalizes the update and resolves the linked Google account.
3. Voice input is transcribed when needed.
4. OpenAI maps the request into a structured action.
5. The app either asks for clarification, prepares an action, or executes the workflow.
6. Google Workspace APIs perform the final action.
7. Pocket Secretary reports the result back in Telegram.

## Stack

- Next.js 15 App Router
- React 19
- TypeScript
- Telegram Bot API
- OpenAI API
- Google OAuth and Google Workspace APIs
- Upstash Redis

## Current Workflows

### Calendar

- Schedule an event from natural language
- Resolve attendees from Google Contacts
- Store confirmation state before execution
- Inspect recent calendar windows for invite-conflict handling

### Gmail

- Draft or send email-style actions from Telegram
- Reply to recent email context
- Reuse recent inbox context from the watcher script

### Docs

- Turn notes or free-form text into a Google Doc

### Account Linking

- Generate a Telegram-specific connect link
- Complete Google OAuth in the web app
- Store encrypted Google tokens for later execution

## Local Development

### Prerequisites

- Node.js 22+
- A Telegram bot token
- An OpenAI API key
- Google OAuth credentials with Workspace scopes
- An Upstash Redis database

### Install

```bash
npm install
```

### Configure Environment

Copy `.env.example` to `.env.local` and fill in the required values.

Important variables:

- `APP_URL` and `NEXT_PUBLIC_APP_URL`
- `SESSION_SECRET`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

Default local OAuth callback:

```text
http://localhost:3000/api/oauth/google/callback
```

### Run The App

Start the Next.js app:

```bash
npm run dev
```

In a second terminal, start the Telegram polling runner:

```bash
npm run bot:poll
```

Optional: run the inbox watcher that keeps recent email context available for Telegram reply flows:

```bash
npm run email:watch
```

### Local URLs

- Home: `http://localhost:3000/`
- Connect flow: `http://localhost:3000/connect`
- Health check: `http://localhost:3000/api/health`
- Telegram endpoint: `http://localhost:3000/api/telegram`

## Telegram Modes

This repo supports two ways to receive Telegram updates:

- Local development: `scripts/bot-poll.mjs` clears any webhook and long-polls Telegram, then forwards updates to `APP_URL/api/telegram`
- Deployment: Telegram can post directly to `app/api/telegram/route.ts`, optionally protected by `TELEGRAM_WEBHOOK_SECRET`

## Google OAuth

Pocket Secretary links a Telegram identity to a Google account through a short-lived connect token:

- Telegram generates a connect link
- `/connect` presents the button
- `/api/oauth/google` creates OAuth state in Upstash
- `/api/oauth/google/callback` exchanges the code, stores encrypted tokens, and notifies the user in Telegram

## Scripts

- `npm run dev`: start the Next.js app
- `npm run build`: production build
- `npm run start`: run the production server
- `npm run typecheck`: TypeScript check
- `npm run bot:poll`: local Telegram polling bridge
- `npm run email:watch`: poll Gmail context for reply-oriented flows

## Project Layout

```text
app/
  api/
    health/
    oauth/google/
    telegram/
  chat/
  connect/
src/
  agent/
  bot/
  integrations/
  lib/
  types/
scripts/
docs/
```

## Deployment Notes

The app is structured for Vercel deployment:

- Next.js routes host OAuth, webhook, and health endpoints
- Upstash Redis holds operational state and idempotency data
- Google remains the source of truth for calendar, mail, contacts, and docs
- Telegram stays the primary user interface

For production, use an `https` `APP_URL`, configure the Google OAuth redirect URI to match it, and point your Telegram webhook to `/api/telegram` if you are not using the polling runner.

## Status

Pocket Secretary is an MVP codebase focused on the core operator loop:

- message in
- intent extraction
- Google action out

The current implementation is optimized for a working local/dev workflow and a deployable backend surface, not a finished consumer product.
