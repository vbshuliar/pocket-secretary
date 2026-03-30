# Pocket Secretary

## Summary

Pocket Secretary is a Telegram-based workflow agent that turns a user's text or voice message into a concrete action inside their Google account.

For the MVP, Pocket Secretary supports three action types:

- create a Google Calendar event
- create a Gmail draft
- create a Google Doc from notes

The product goal is simple: the user speaks once in Telegram, Pocket Secretary understands the request, prepares the right action, and returns a clear confirmation or result.

## Product Goal

Pocket Secretary should feel like a lightweight personal operator:

- receive a message in Telegram
- understand the user's intent
- resolve the people, time, and content referenced in the request
- perform the right Google action
- show the result back in Telegram

The MVP should optimize for reliability and a strong demo, not full autonomy.

## Primary User

The initial user is a busy individual who already uses Telegram and Google Workspace:

- founders
- freelancers
- operators
- students
- salespeople

## Core MVP Workflows

### 1. Calendar Event

Example:

> "Set up a meeting with my mum tomorrow at 3pm"

Expected behavior:

- transcribe the voice note if needed
- detect a calendar event request
- resolve "mum" against Google Contacts
- normalize the time reference
- prepare an event draft
- show the proposed event in Telegram
- execute only after confirmation

### 2. Gmail Draft

Example:

> "Write an email to Alex about the pitch deck"

Expected behavior:

- transcribe the voice note if needed
- detect an email draft request
- resolve Alex in contacts
- generate subject and body
- show the draft in Telegram
- save as a Gmail draft after confirmation

### 3. Notes to Google Doc

Example:

> "Save this as meeting notes from today's call"

Expected behavior:

- transcribe the voice note if needed
- detect a notes request
- clean and structure the notes
- create a Google Doc
- return the document title and link in Telegram

## Non-Goals For MVP

The MVP does not need to support:

- multi-step follow-up conversations across many turns
- sending email without confirmation
- editing existing calendar events
- complex calendar availability logic
- collaborative document editing
- broad assistant chat behavior unrelated to workflows

## Deployment Assumptions

Pocket Secretary will be deployed as a Vercel application.

Architecture assumptions:

- the user-facing app is built on Vercel's Chat SDK stack
- Telegram is the external input channel
- Telegram sends updates to a Vercel webhook route
- the app stores lightweight state in Upstash Redis
- Google APIs are called from server-side routes or server actions

This means the repository should separate:

- `app/` for Next.js routes, pages, and API endpoints
- `src/` for Pocket Secretary domain logic
- `docs/` for specifications and runbooks

## System Boundaries

The codebase should be split by responsibility.

### `app/`

Owns the Vercel web app surface:

- Chat SDK routes and UI
- Telegram webhook endpoints
- OAuth callback routes
- health and debug endpoints if needed

### `src/bot`

Owns Telegram-facing behavior:

- receive updates from Telegram
- detect message type: text, voice, audio
- download voice files
- pass normalized input to the agent layer
- display confirmations, clarifications, and final results

### `src/agent`

Owns Pocket Secretary orchestration:

- take normalized user input plus account context
- call transcription when needed
- classify intent
- extract structured action data
- decide whether to clarify, draft, or execute
- produce a machine-readable action plan

### `src/integrations`

Owns third-party integrations:

- Telegram transport helpers if shared
- Google OAuth
- Google People API
- Google Calendar API
- Gmail API
- Google Docs API
- speech-to-text provider

### `src/types`

Owns shared schemas and types:

- transcript result
- intent classification
- contact match result
- action payloads
- confirmation payloads
- error payloads

### Upstash Redis

Upstash Redis should be used for short-lived operational state:

- Telegram chat to user/account mapping
- OAuth session state and nonce values
- pending confirmation actions
- recent transcript or action metadata
- idempotency keys for Telegram update processing

## Request Lifecycle

The end-to-end flow for Pocket Secretary should be:

1. Telegram message received.
2. A Vercel route in `app/` validates the webhook and forwards the payload.
3. `src/bot` normalizes the input into a common request shape.
4. The app checks Upstash for user linkage, pending actions, and idempotency.
5. If the message is voice, the agent requests transcription.
6. `src/agent` classifies the intent and extracts structured fields.
7. The agent resolves contacts and normalizes relative dates and times.
8. The agent decides one of three outcomes:
   - ask a clarifying question
   - prepare a draft for confirmation
   - execute immediately if the action is safe and policy allows it
9. `src/integrations` performs the selected Google action.
10. pending confirmation state is stored or cleared in Upstash as needed.
11. `src/bot` sends a compact result message back to Telegram.

## Persistence Model

Upstash Redis should not be treated as a permanent system of record. It is an operational store.

Use it for:

- webhook deduplication
- temporary conversation state
- confirmation payloads awaiting user approval
- user-to-Google-account linkage metadata

Do not depend on it for:

- long-term document storage
- source-of-truth calendar or email data
- large transcript archives

## Action Contract

The agent should never return free-form instructions to the integration layer. It should return a structured action object.

### Base Shape

```json
{
  "action_type": "create_calendar_event",
  "status": "needs_confirmation",
  "confidence": 0.93,
  "requires_clarification": false,
  "clarification_question": null,
  "payload": {},
  "user_visible_summary": "Draft a calendar event with Alex tomorrow at 3:00 PM.",
  "warnings": []
}
```

### Supported `action_type` Values

- `create_calendar_event`
- `create_gmail_draft`
- `create_google_doc`
- `clarify_request`
- `unsupported_request`

### Calendar Payload

```json
{
  "title": "Meeting with Mum",
  "start_at": "2026-03-31T15:00:00+01:00",
  "end_at": "2026-03-31T15:30:00+01:00",
  "timezone": "Europe/London",
  "attendees": [
    {
      "display_name": "Mum",
      "email": "mum@example.com",
      "source": "google_people"
    }
  ],
  "description": "Created from Telegram by Pocket Secretary."
}
```

### Gmail Payload

```json
{
  "to": [
    {
      "display_name": "Alex",
      "email": "alex@example.com",
      "source": "google_people"
    }
  ],
  "subject": "Pitch deck follow-up",
  "body_text": "Hi Alex,\n\nWanted to follow up on the pitch deck...\n",
  "body_html": null
}
```

### Google Doc Payload

```json
{
  "title": "Meeting Notes - 2026-03-30",
  "content_markdown": "# Meeting Notes\n\n- Action item 1\n- Action item 2\n",
  "source_summary": "Structured from a Telegram voice note."
}
```

## Confirmation Policy

Pocket Secretary should default to drafts and confirmations for any external action.

### Always Confirm

- calendar creation
- Gmail draft creation if recipient or content was inferred
- any request with ambiguous contact resolution
- any request with missing date or time details

### Can Execute Without Confirmation

- document creation when the user explicitly asked to save notes
- low-risk formatting actions that do not notify third parties

### Must Clarify Before Drafting

- no matching contact found
- more than one likely contact match
- date or time is missing or too ambiguous
- the request maps to more than one action type

## Contact Resolution Rules

Contact resolution should be deterministic and user-visible.

- prefer exact display-name matches from Google People
- allow nickname or relationship-name matches such as "mum" only if the contact data supports it
- if one contact is clearly dominant, show the matched contact in the confirmation message
- if multiple contacts are plausible, return a clarification prompt instead of guessing
- never silently send or schedule with an unresolved contact

## Failure Handling

Pocket Secretary should fail clearly and compactly.

### Expected Failures

- transcription failed
- Google OAuth missing or expired
- no supported intent detected
- contact not found
- relative time could not be normalized
- Google API request failed

### User Response Rules

- explain the blocking issue in one short message
- keep the response action-oriented
- offer the next best step when possible

Example:

> I found two contacts for Alex. Reply with the correct email or full name.

## Privacy And Security

The MVP should keep the security model simple but explicit.

- request only the Google scopes required for the supported workflows
- store OAuth tokens securely and avoid logging them
- keep Telegram webhook verification and secret configuration on the server side
- keep Upstash keys and Google credentials only in Vercel server environment variables
- do not retain raw voice files longer than needed for processing
- do not log full transcript content unless debugging is explicitly enabled
- keep created action metadata for auditability

## Demo Script

The demo should show a full successful loop in under one minute.

### Demo 1

- send a voice note asking for a meeting to be set up
- Pocket Secretary transcribes and extracts the request
- the bot matches the contact
- the bot shows the event draft
- the user confirms
- the bot returns success

### Demo 2

- send a voice note asking for an email draft
- Pocket Secretary drafts the email
- the draft preview appears in Telegram

### Demo 3

- send a voice note with rough notes
- Pocket Secretary creates a Google Doc
- the bot returns the document link

## Build Order

The implementation order should be:

1. Vercel app scaffold with Chat SDK baseline
2. Telegram webhook route and local message normalization
3. Upstash Redis connection for idempotency and pending state
4. speech-to-text integration
5. action classification and schema output
6. Google OAuth connection flow
7. Google Calendar event draft path
8. Gmail draft path
9. Google Doc creation path
10. confirmation and clarification UX

## Success Criteria

The MVP is successful if one user can:

- connect a Google account
- send a text or voice request in Telegram
- have Pocket Secretary identify one supported action
- review a clear confirmation message
- complete at least one Google action successfully

## Immediate Next Files

The next documents and modules to add after this plan are:

- `docs/action-schema.md`
- `docs/vercel-architecture.md`
- `docs/demo-script.md`
- `app/api/telegram/route.ts`
- `app/api/oauth/google/route.ts`
- `src/bot/telegram.ts`
- `src/agent/index.ts`
- `src/integrations/google/`
- `src/types/actions.ts`
