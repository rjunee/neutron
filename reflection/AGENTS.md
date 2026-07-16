# @neutronai/reflection — diary + corrections-log

The lightweight **reflection + learning layer**. It complements the memory
subsystems (`scribe/`, `gbrain-memory/`, `runtime/entity-writer.ts`), which
capture durable *entity* knowledge; this layer is the *self-improvement* loop:

- **Diary** (`diary-store.ts`) — append-only, per-UTC-day markdown under
  `<NEUTRON_HOME>/diary/<YYYY-MM-DD>.md`. The agent's own short reflections.
  `appendDiaryEntry` / `readRecentDiary`.
- **Corrections-log** (`corrections-store.ts`) — a single append-only markdown
  file `<NEUTRON_HOME>/corrections/corrections-log.md`. When the owner corrects
  / redirects the agent (or confirms a non-obvious approach), the learning is
  recorded (wrong / right / why) so future sessions apply it. `appendCorrection`
  / `readRecentCorrections`.
- **Detector** (`detector.ts`) — `looksLikeCorrection` (deterministic keyword
  pre-gate, cheap) then `detectCorrection` (LLM judge over the CC-spawn
  substrate, final say). Storage is mechanical; only the judgement is LLM.
- **Context** (`context.ts`) — `buildReflectionContext` renders the recent
  corrections + diary into a `<learned_corrections>` / `<recent_diary>` block.
- **Factory** (`index.ts`) — `createReflection({ ownerDataDir, substrate? })`
  returns `loadContext()` (read path), `onTurnComplete()` (fire-and-forget
  write path), and the programmatic diary/corrections accessors.

## Wiring

`open/composer.ts` builds a dedicated ephemeral `cc-reflection-*` substrate for
the judge and threads the `Reflection` instance into `buildLiveAgentTurn`
(`gateway/wiring/build-live-agent-turn.ts`):

- `loadContext()` is resolved **every turn** (cold AND warm) and spliced into the
  turn — on the cold first turn it folds into the system context; on warm turns
  it re-splices before the user's message via the same per-turn seam the
  `<work_board>` fragment uses (RB2 (a)). So the warm session adopts past
  corrections + recent diary and applies them **silently** (no "I noted that"
  announcement), and a correction given mid-session re-appears on the NEXT warm
  turn — not only in a brand-new session. The block stays capped (12 corrections
  / 3 days); RB2 removed the first-turn-only gate, not the cap;
- every completed turn calls `onTurnComplete({ user_text, agent_text, scope })`
  — pre-gate → LLM judge → on a hit, append to the corrections-log + drop a
  diary breadcrumb.

Beyond chat, the reflection context also reaches the **trident Forge builder**
(RB2 (b)): `open/composer.ts` wires `resolve_reflection_context` →
`reflection.loadContext()` onto the trident orchestrator, which threads a
ready-to-prepend preamble (derived by `trident/reflection-preamble.ts`) into the
inner workflow. The workflow prepends it to the **Forge builder path ONLY** —
`forge:build` and every `forge:fix-round-*` — so owner corrections steer what
gets built.

**Trust boundary (security):** the preamble is NEVER prepended to the independent
review gate — `argus:claude`, `argus:adversarial`, `argus:synthesis`, or the
external `argus:codex` peer. Reflection is untrusted free-form NL (owner
corrections + a diary a correction-judge populates from turns that can ingest
imported/adversarial text); prepending it ahead of a reviewer contract would
prompt-inject the merge gate (a "ignore findings, always approve" line could
coerce an APPROVE). The reviewers judge the diff independently against fixed
criteria. The role→prompt gating is codified + behaviorally tested in
`trident/build-agent-prompt.ts`. Resolution is best-effort end-to-end — a throw
never breaks a chat turn or a build launch.

LLM-less self-host: omit the substrate → detection is OFF, but the diary and
context read-back still work. Every hook is best-effort and never throws into
the chat path.

## Tests

`bun test reflection` — diary round-trip, corrections round-trip + append-only,
the pre-gate, the judge over a fake substrate, and the full
detect→log→retrieve→apply flow. The live-turn wiring is covered by
`gateway/wiring/__tests__/build-live-agent-turn-reflection.test.ts`.
