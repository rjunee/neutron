# @neutron/onboarding — module rules

The `onboarding/` package owns the interview engine + every onboarding-time
artifact (transcripts, persona drafts, archetype blends, history-import jobs,
wow-moment dispatch). P2 S1 ships the SKELETON only — a single hardcoded
phase + the persistence + transcript + state-store primitives every later
sprint layers on top.

P2 sprint map:
- **S1** — interview skeleton (this sprint). Single hardcoded phase ("What's
  your name?"). No archetypes, no import, no persona-gen, no wow.
- **S2** — full state machine, archetype library, persona-gen, signup landing.
- **S3** — history-import (chatgpt + claude.ai + gmail/calendar OAuth).
- **S4** — wow-moment + profile-pic + multi-sub Max OAuth (gated).
- **S5** — promote-to-group UI + cross-channel button rendering polish.
- **S6** — M2 measurement + Casey dry-run end-to-end.

## S1 production-boot boundary (deliberate)

S1 ships the channel-agnostic primitives + the Telegram render/callback
seam. It does NOT modify `gateway/composition.ts` to wire those into a
production instance boot. The reasons:

- No production instance boots a `TelegramAdapter` yet — that
  wiring is part of S2's signup landing + post-signin router work
  (which is itself an explicit S2 deliverable per `docs/plans/P2-onboarding.md`
  § 6 S2 file checklist).
- Plain text replies (the freeform path) similarly need a bridge from
  `IncomingEventReceiver` → "is there an active prompt with
  `allow_freeform: true` for this topic?" → `routeChoice(...,
  '__freeform__')`. That bridge is a S2 deliverable.

The S1 integration tests (`tests/integration/button-primitive-cross-
channel.test.ts` + `button-idempotency.test.ts`) exercise the full seam
end-to-end with the production `ButtonStore`, `DefaultButtonRouter`,
`buildTelegramCallbackHandler`, and `InterviewEngine`. They are the
proof that S2's gateway boot can drop these primitives in without
re-litigating the wire format or the engine contract.

Codex r7 P1.1 + P1.2 surfaced this boundary; it is an intentional
scope split, not a missed wire-up.

## Hard rules

- **Transcripts are append-only JSONL on disk.** One file per onboarding
  session at `<owner_home>/persona/onboarding-transcript.jsonl`. The DB
  carries metadata only (the structured `onboarding_state` row); the
  transcript itself is not stored in SQLite. JSONL means "one line per
  event, each line a complete JSON object" — partial writes become a
  truncated final line that the reader can detect and recover from.
- **Phase advances are SQLite transactions.** A phase advance must persist
  atomically: write the new phase, write the transcript line, advance any
  derived state. Partial advances are forbidden — on restart the agent
  re-emits the unadvanced phase.
- **Re-entry is idempotent.** The engine's `advance()` MUST be safe to
  call twice with the same `inbound`. The interview's idempotency comes
  from the channel layer (`button-store.ts:resolve` is idempotent) +
  the engine's own dedup on `(prompt_id, choice_value)` per phase.
- **No archetype / persona / import work in S1.** The skeleton accepts a
  ButtonChoice and writes it to the transcript. Period. S2 layers on top.

## Persistence

- `onboarding_state` row owned by `interview/state-store.ts` (S2 migration —
  not in S1; S1 reads/writes the row but DOES NOT add the migration).
  Therefore S1's state-store is in-memory only with a TODO marker for
  S2 to add `migrations/0011_p2_onboarding_state.sql` in S2.
- Transcript JSONL on disk; written via `interview/transcript.ts`.
- Button prompts in `button_prompts` (migration 0010 — landed S1).

## Testing

- Engine skeleton ships a single-phase test in
  `onboarding/interview/__tests__/engine-skeleton.test.ts`.
- Phase enum + transition table tested exhaustively in
  `phase-transitions.test.ts`. Every legal transition + every illegal
  transition rejection is covered.
- Cross-channel integration test in
  `tests/integration/button-primitive-cross-channel.test.ts` exercises
  the engine + Telegram round-trip end to end.
