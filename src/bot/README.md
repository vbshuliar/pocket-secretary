# `src/bot`

This module owns Telegram-facing logic for Pocket Secretary.

Responsibilities:

- validate and normalize Telegram updates
- download voice files through the Telegram Bot API
- map Telegram chats to internal user state
- format replies, confirmations, and clarifications

Suggested first files:

- `telegram.ts`
- `normalize.ts`
- `messages.ts`
