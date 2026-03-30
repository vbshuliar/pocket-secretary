# `src/agent`

This module owns Pocket Secretary orchestration.

Responsibilities:

- trigger transcription for voice input
- classify the incoming request
- extract structured action payloads
- resolve contacts and normalize time references
- apply confirmation and clarification policy

Suggested first files:

- `index.ts`
- `classify.ts`
- `extract.ts`
- `policy.ts`
