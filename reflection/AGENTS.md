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

- the FIRST turn on each (instance, topic) splices `loadContext()` into its
  system context — so the warm session adopts past corrections + recent diary
  and applies them **silently** (no "I noted that" announcement);
- every completed turn calls `onTurnComplete({ user_text, agent_text, scope })`
  — pre-gate → LLM judge → on a hit, append to the corrections-log + drop a
  diary breadcrumb.

LLM-less self-host: omit the substrate → detection is OFF, but the diary and
context read-back still work. Every hook is best-effort and never throws into
the chat path.

## Tests

`bun test reflection` — diary round-trip, corrections round-trip + append-only,
the pre-gate, the judge over a fake substrate, and the full
detect→log→retrieve→apply flow. The live-turn wiring is covered by
`gateway/wiring/__tests__/build-live-agent-turn-reflection.test.ts`.
