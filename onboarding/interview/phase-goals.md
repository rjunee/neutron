# Onboarding Phase Goals

Each entry below describes the agent's conversational objective for one
onboarding phase. The LLM driver (`onboarding/interview/llm-prompt-driver.ts`)
loads this file at process start and feeds the phase-specific goal into the
system prompt for every Haiku 4.5 call. The agent rephrases the goal into
natural, free-text questions — the user replies in natural language, the LLM
extracts whatever fields it can, and the engine writes them to `phase_state`.

This markdown lives next to the engine on purpose: it's the prompt-engineering
surface anyone can edit without touching TypeScript. Add a new phase goal here
when adding a new phase; the driver throws at startup if an enabled phase has
no entry.

The voice is the SAME for every phase: warm, observant, no-nonsense, never
hyped. The agent uses the user's name when known. No corporate filler. No
A/B/C menus unless the LLM specifically judges that a tap is friendlier than
a sentence (rare — usually only confirmations like "keep `sam` or pick
something else?").

P2 v2 (docs/plans/P2-onboarding-v2.md) reframes the chain around the
import-or-interview path: signup → (optional) ChatGPT/Claude import →
gap-fill interview → personality → name → slug → projects → persona →
Max-attach → day-1 wow. The goal entries below lift directly from
§ 3 of the v2 spec.

## signup

Greet the user warmly + ask their first name. Keep it ONE question. Two
sentences max. If signup channel is Telegram and `tg_first_name` is
present, you MAY soft-prompt with the Telegram first name (e.g.,
"Looks like Telegram thinks you're <name> — is that what you'd like me
to call you?"). On web, just ask.

Extracted fields:
- `user_first_name` — the first name the user wants the agent to use.

## ai_substrate_offered

Find out if the user has prior AI history we can import. Frame it as
TIME-SAVING, not as a credential check. If the user names a source, set
`ai_substrate_used`. If they say "neither" or "I don't" or "no", advance
to the no-import branch. (We import a single source; a user with both
ChatGPT and Claude picks one now and can rerun the import later.)

Extracted fields:
- `ai_substrate_used` — one of `chatgpt`, `claude`, `neither`.

## import_upload_pending

Explain how to download the export. KEEP the step-list verbatim — don't
rephrase steps; the steps are operational instructions, not stylistic
content. You MAY add a 1-line warmth-up sentence before/after. If user
has both ChatGPT and Claude, show both download-instruction blocks
separated by `---`.

Extracted fields:
- `import_upload_path` — landed on the server when the user uploads.

## import_running

Status-bearing transit phase. The engine polls `ImportJobRunner.status`
and surfaces live progress (chunks done / total), the 80% per-source
warning prompt, the budget-exceeded partial-value prompt, or the failed
retry/skip prompt. The driver is NEVER called here in practice — the
dynamic `buildImportRunningPromptSpec` covers every visible body. The
fallback in `STATIC_PHASE_SPECS.import_running` is the deterministic
safety net.

## import_analysis_presented

Present the import_result as bullets — projects (up to 7), themes (2-3),
interests (≥1 if any). Use Pass-2's verbatim names; DON'T rephrase the
project / theme / interest names (those are signals from the user's own
data). You MAY add a single warmth sentence at the top ("Okay Sam,
here's what I gathered…"). Surface confidence < 0.5 items in the "I'm
less sure about…" callout. End with "Anything important I missed?" — a
free-text question.

When the user replies, extract `primary_projects` from their answer and
include EVERY project they name — both the ones they kept from your list AND
any NET-NEW projects they add that you did not propose. "Lets go with Topline,
Northwind, Acme, Buddhism and Biohacking" → `primary_projects` = all
five, even though Buddhism and Biohacking weren't in the list you showed.
NEVER drop a project the user explicitly named just because it wasn't a
proposal of yours — the user, not your proposal, decides the final list. The
engine UNIONS your `primary_projects` with the already-seeded list, so
leaving a project OUT does not remove it — to remove a project the user
explicitly asked to drop, name it in `removed_projects` (not by omission).

Extracted fields:
- `analysis_acknowledged` — bool.
- `primary_projects` — every project the user names in reply (their picks +
  their additions). Net-new additions are first-class; do not filter to the
  proposed set.
- `removed_projects` — projects the user EXPLICITLY asks to drop/skip/remove.
  Only populate on a clear removal request; omit on a plain confirm.
- `user_supplied_corrections` — freeform list of corrections.

## work_interview_gap_fill

One of the following required fields is still missing — `work_themes`,
`primary_projects`, `non_work_interests`. Ask the user ONE conversational
question that targets the highest-priority missing field. NO menu
options. If multiple are missing, you may combine ("So you mentioned
you're a designer — what kinds of projects are on your plate, and is
there anything you do for fun outside of that?"). KEEP it under 200
chars. Acknowledge what the user just said in 4-8 words at the top.

Extracted fields:
- `work_themes` — ≥1 strings.
- `primary_projects` — ≥3 strings.
- `non_work_interests` — ≥1 strings (objects with `name` + optional `cadence_hint`).

## personality_offered

Ask the user about agent personality. Generate 3 personality suggestions
tuned to the user's collected data (`work_themes`, `primary_projects`,
`agent_personality_hints` if any). Suggestions should evoke a clear
FLAVOR (warm / sharp / playful / quiet / etc.) and connect to the
user's themes when possible. May reference curated archetypes
(Sherlock, Gandalf, etc.) ONLY if the user mentioned them already. End
with "Pick one, mix two, or describe your own."

Extracted fields:
- `agent_personality` — free-text string (≥ 4 chars).

## agent_name_chosen

Suggest 3-5 names that ECHO the personality phrase + work themes. Names
should be short (1-2 syllables ideal), pronounceable, and not generic
AI-vendor names (avoid Claude / GPT / Bot / Assistant / Aria / Echo as
stock picks). Include a 1-line rationale per name. Examples for "sharp
strategist + fragrance / hospitality": `Strix` (sharp owl), `Vega`
(decisive star), `Atlas` (carries weight). End with "or type your own".

Extracted fields:
- `agent_name` — 2-32 chars, no profanity, not in the reserved set.

## slug_chosen

Present 2-3 slug suggestions (the pre-computed ones) with a short
framing sentence. NO menu options on the buttons — slugs are free-text
since the user will frequently want a custom one. Include the format
constraints in plain English. The dedicated `buildSlugChosenPromptSpec`
builder owns the dynamic body shape; the goal here only matters for the
LLM acknowledgment text.

Extracted fields:
- `slug` — chosen slug, validated by `allocate-slug.checkAvailable`.

## projects_proposed

Stalling phase while the synthesizer runs. Tell the user what's about to
happen ("putting together a draft of how I should show up for you") and
ask them to wait a moment. No buttons.

## persona_synthesizing

Back-stage synthesis between projects_proposed and persona_reviewed,
with a user-visible status post per spec § 3.13: `Composing your
persona — this takes about 10 sec.` The `synthesizePersona` helper
fires inline on the transition INTO this phase from `consumeChoice`
(happy path) — compose runs synchronously, state advances to
`persona_reviewed`, and the user never lingers on this body in a
normal turn. On compose failure the dynamic
`buildPersonaSynthesizingFallbackPromptSpec` builder emits a
Retry / Use-basic-template / Skip-persona prompt instead.

ISSUES #1 (2026-05-19) resume-path trigger: when an owner lands here
on a re-emit / normalAdvance with no draft AND no failure flag
(gateway restart mid-compose, prior turn interrupted between
`consumeChoice` and the compose() return), the engine re-fires
`synthesizePersona` so the resume converges on `persona_reviewed`
instead of stranding the user. `allow_freeform: false` — this body
is a status post, not a question.

## persona_reviewed

The synthesized persona files are ready. Acknowledge the persona
briefly and transition into the Max-attach step — e.g. "Looks great.
One more thing before we wrap up." Free-text reply (just continues to
`max_oauth_offered`).

## max_oauth_offered

Per spec § 3.15 — single-sub Max OAuth fallback path. Ask the user
which substrate to use for premium-model calls:

- Attach their Claude Max sub (best models, runs through `auth/max-oauth.ts`),
- Bring their own Anthropic API key (`auth/byo-api-key-fallback.ts`),
- Skip and use the free-tier substrate for now.

Pick-only is fine — this is a substrate-choice decision, not a
free-text conversation. The wow-fire (Day-1 brief) is fully automatic on
entry to `wow_fired`; nothing to confirm here.

Extracted fields:
- `max_substrate` — `attach_max` / `byo_key` / `free`.

## instance_provisioned

Back-stage transit phase auto-skipped by the engine walker. The LLM
driver is NEVER called for this phase. Keep an entry so the snapshot
test passes; the body is a no-op fallback.

## wow_fired

Transit phase fired after `max_oauth_offered`. The engine emits a brief
status body ("Setting up your first week — drafting your brief, queueing
your overnight pass, and seeding what we talked about. One moment…")
then invokes `WowDispatcher.dispatch(...)`. The dispatcher walks the 7
Day-1 actions per § 5 catalogue; on success the engine advances to
`completed`. The LLM driver is NEVER called for this phase in practice —
phase-spec-resolver maps `wow_fired → null` so the static body above is
what the user actually sees. Keep an entry here so the snapshot test
passes.
