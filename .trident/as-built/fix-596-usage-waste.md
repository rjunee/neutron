## Issue 596 — usage spend, attribution, waste, and cap intervals

### What changed

Codex rollout usage now enters an append-only ledger through a durable byte watermark. The parser accepts only real `event_msg` / `token_count` cumulative snapshots, validates cached-input and reasoning-output as subsets, and converts successive snapshots to per-line deltas (`trident/transcript-usage.ts:37-68`). The reader consumes at most 1 MiB per call, advances only through newline-terminated records, rejects truncation and cumulative regression, and commits events with their watermark in one transaction (`trident/transcript-usage.ts:70-137`). Migration 0150 owns both strict tables and their subset constraints (`migrations/0150_transcript_usage_events.sql:1-30`).

The existing terminal observer remains first. Its new follower resolves the run's active Codex credential directory, considers only rollouts newer than the run, verifies the rollout's own working-directory metadata against the run, and stamps project, task topic, agent, phase, and run id (`open/composer.ts:7047-7072`). Collection failure stays best-effort telemetry and cannot change the already-committed terminal verdict (`open/composer.ts:7068-7070`). This continuously maintains the ingest invariant from the orchestrator's terminal callback rather than depending on the completed child process.

The dashboard read model unions the new event grain with the older phase-snapshot grain and exposes project, topic, agent, and phase breakdowns (`trident/usage-analytics.ts:126-141,164-171`). Cached and reasoning subsets are excluded from additive totals for transcript rows (`trident/usage-analytics.ts:64-69`). The web and mobile decoders preserve the new fields and both settings surfaces render them (`landing/chat-react/usage-dashboard-client.ts:119-135,297-315`; `app/lib/usage-dashboard-client.ts:139-155,311-327`; `landing/chat-react/SettingsTab.tsx:1652-1675`; `app/app/usage.tsx:274-294`).

Waste now joins the existing `terminalRunDisposition` vocabulary and a three-band artifact classification. Approved completed runs default to merged; terminal runs with a recorded head distinct from base are recoverable; terminal runs without surviving ahead-of-base evidence are unrecoverable; nonterminal or unattached events remain unclassified (`trident/usage-analytics.ts:98-120`). Only the unrecoverable band contributes to the waste headline, while all three bands are returned and rendered (`trident/usage-analytics.ts:173-180`).

Both client projections derive an all-accounts-capped interval only when every account has a known spent standing; it spans the render instant to the earliest binding reset and disappears if any account is unknown (`landing/chat-react/usage-dashboard-client.ts:780-788`; `app/lib/usage-dashboard-client.ts:792-800`). Both settings surfaces render the interval beside the pool capacity line (`landing/chat-react/SettingsTab.tsx:1764-1774`; `app/app/usage.tsx:228-238`).

### Decisions

The transcript ledger is separate from `code_trident_phase_usage`: that table stores one replaceable cumulative snapshot per run and phase (`trident/phase-usage.ts:3-15,37-58`), while this issue requires one row per accepted transcript line. The source path plus byte offset is the idempotency key (`migrations/0150_transcript_usage_events.sql:10-26`).

Attribution is explicit input and production verifies the rollout's own `session_meta.payload.cwd`; a concurrent session from another repository is refused rather than guessed (`trident/transcript-usage.ts:91-105`). Phase selection uses the committed checkpoint vocabulary at the terminal seam (`open/composer.ts:7062-7067`).

The all-capped interval is computed on the client because capacity is already render-clock policy there (`landing/chat-react/usage-dashboard-client.ts:748-756`). Unknown accounts suppress the interval; absence never becomes permissive.

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Reasoning must be a subset of output (`trident/transcript-usage.ts:54`) | Compared reasoning with `Number.MAX_SAFE_INTEGER`; mutation printed at line 52 before later edits | `reasoning is an output subset and never an additive token class` received a parsed event instead of null | `bun test trident/transcript-usage.test.ts`: 4 pass |
| Ahead-of-base work is recoverable (`trident/usage-analytics.ts:119`) | Inverted `head !== base` to equality; mutation printed at line 119 | `transcript attribution is visible and a surviving ahead-of-base branch is recoverable, not waste` received null instead of 120 | `bun test trident/usage-analytics.test.ts`: 3 pass |
| Unknown account suppresses all-capped interval (`landing/chat-react/usage-dashboard-client.ts:786`; mobile twin `app/lib/usage-dashboard-client.ts:798`) | Relaxed `unknown === 0` to `unknown >= 0`; both mutated lines were printed | `the all-accounts-capped band spans now to first proven capacity and refuses unknown accounts` received an interval instead of null | `bun test gateway/__tests__/usage-dashboard-client-parity.test.ts`: 54 pass |

### Validation

- `bun test trident/transcript-usage.test.ts trident/usage-analytics.test.ts gateway/__tests__/usage-dashboard-client-parity.test.ts gateway/__tests__/app-usage-surface.test.ts migrations/runner.test.ts migrations/__tests__/live-ledger-125-repair.test.ts migrations/snapshot.test.ts tests/integration/identity-env-readers-registry.test.ts`: 122 pass.
- `bun test landing/chat-react/__tests__/usage-dashboard-web.test.tsx`: 37 pass.
- `bun test app/__tests__/usage-dashboard-reachable.test.tsx`: 25 pass.
- `bunx tsc -p trident/tsconfig.json --noEmit`, gateway, landing, and Open equivalents: pass.
- `bunx eslint` over every touched TypeScript/TSX file and `git diff --check`: pass. `scripts/ci/leak-gate.sh` reported zero findings from runnable rules but classified the local run incomplete because its external PII denylist was unavailable; CI owns that external input.
- Migration 0150 is included in the exhaustive applied lists (`migrations/runner.test.ts:204-216`; `migrations/__tests__/live-ledger-125-repair.test.ts:82-94,170-177`) and the schema snapshot was regenerated.

### Deliberately not done

No transcript content heuristic assigns projects or topics: those values come from the committed run, and the rollout must corroborate its working directory. No pricing conversion or cross-provider sum was introduced. Historical phase rows remain visible as unknown rather than being backfilled from current settings. No existing quota gauge path was replaced, and no feature flag or alternate runtime path was added.

The filed scope does not change a product decision in `SPEC.md` or an existing spec item, so neither was edited.
