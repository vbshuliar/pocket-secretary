# Vercel Architecture

## Target Stack

Pocket Secretary should use:

- Vercel for deployment
- Next.js app router for routes and server endpoints
- Chat SDK for the web app surface
- Telegram Bot API for inbound user messages
- Upstash Redis for operational state

## Recommended Layout

```text
app/
  api/
    telegram/
      route.ts
    oauth/
      google/
        route.ts
  chat/
    page.tsx
src/
  agent/
  bot/
  integrations/
    google/
  types/
docs/
```

## Data Responsibilities

### Telegram

- source of inbound user messages
- source of chat identifiers and transport metadata

### Upstash Redis

- pending action confirmations
- chat-to-user linkage
- idempotency keys
- short-lived session state

### Google Workspace APIs

- source of truth for calendar, email, contacts, and docs

## Critical Server Flows

### Telegram Webhook

1. receive update
2. reject duplicates via Upstash
3. normalize payload
4. invoke Pocket Secretary agent
5. reply to Telegram

### Google OAuth

1. initiate OAuth from the Vercel app
2. store nonce and session state in Upstash
3. receive callback
4. store resulting account linkage securely

### Pending Confirmation

1. user requests action
2. agent produces draft
3. draft payload stored in Upstash with expiration
4. user confirms in Telegram
5. action executes and pending state is cleared
