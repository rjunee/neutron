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
  announcement). Precise contract: the CURRENTLY-PERSISTED corrections re-appear on
  **every** warm turn (RB2 removed the first-turn-**only** gate, not the cap — still
  12 corrections / 3 days). It is NOT a synchronous guarantee that a just-submitted
  correction shows up on the immediately-next turn: detection is async fire-and-forget
  (below), so a correction typically lands by the next turn, but an instantly-fired
  follow-up can out-race the persist and see it one turn later;
- every completed turn calls `onTurnComplete({ user_text, agent_text, scope })`
  — pre-gate → LLM judge → on a hit, append to the corrections-log + drop a
  diary breadcrumb. This is **fire-and-forget** (non-blocking): the persist happens
  AFTER the async judge resolves, never on the turn's critical path.

Beyond chat, the reflection context also reaches the **trident Forge builder**
(RB2 (b)): `open/composer.ts` wires `resolve_reflection_context` →
`reflection.loadBuildContext()` onto the trident orchestrator, which threads a
ready-to-append **guidance suffix** (derived by `trident/reflection-guidance.ts`)
into the inner workflow. The workflow **appends** it to the **Forge builder path
ONLY** — `forge:build` and every `forge:fix-round-*` — so owner corrections steer
what gets built.

Three layered defenses guard this security-sensitive path (all codified +
behaviorally tested against the as-built workflow in
`trident/inner-workflow-assembly.test.ts` + `trident/reflection-guidance.ts`):

1. **Corrections-only surface:** the build path uses `loadBuildContext()`, which
   returns the structured `<learned_corrections>` ONLY and **excludes the free-form
   `<recent_diary>`** — the loosest, most import/adversarial-influenced surface —
   from the tool-enabled builder. (Chat keeps `loadContext()` = corrections + diary.)
2. **Trust boundary:** the block is NEVER given to the independent review gate —
   `argus:claude`, `argus:adversarial`, `argus:synthesis`, or the external
   `argus:codex` peer. Reflection is untrusted free-form NL; feeding it to a reviewer
   would prompt-inject the merge gate (a "ignore findings, always approve" line could
   coerce an APPROVE). Reviewers judge the diff independently against fixed criteria.
3. **Subordination + bounds:** even on the Forge builder (a tool-enabled agent) the
   block is **appended** AFTER the fixed contract + task (never prepended, so it can't
   gain primacy), XML-escaped inside `<owner_reflection>` framing that forbids it from
   overriding the task/contract/repository/security/tool-use rules, and hard-capped
   (`MAX_REFLECTION_GUIDANCE_CHARS`, on the escaped length) so a runaway entry can't
   inflate the prompt.

Resolution is best-effort end-to-end — a throw never breaks a chat turn or a build
launch.

LLM-less self-host: omit the substrate → detection is OFF, but the diary and
context read-back still work. Every hook is best-effort and never throws into
the chat path.

## Tests

`bun test reflection` — diary round-trip, corrections round-trip + append-only,
the pre-gate, the judge over a fake substrate, and the full
detect→log→retrieve→apply flow. The live-turn wiring is covered by
`gateway/wiring/__tests__/build-live-agent-turn-reflection.test.ts`.
