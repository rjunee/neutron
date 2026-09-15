## 2026-09-15 — Live instance and project provider selection (#869)

### Status and scope

Configuration and substrate dispatch are implemented. **The issue remains open:**
actual Codex build orchestration still depends on #545. The existing launcher asks
for the native Workflow tool (`trident/inner-loop.ts:803`), so a successful Codex
CLI dispatch is not evidence that this workflow executed. The acceptance item
retains that distinction in `docs/spec-items/instance-project-provider-resolution.md`.

### Changes and decisions

- Persist the instance default in its existing metadata table, with a SQL provider
  constraint (`migrations/0148_instance_model_provider.sql:2`). SQL maintains the
  vocabulary independently of a running gateway or a cooperative writer.
- Import the former environment default once at boot (`open/composer.ts:1031`).
  A durable initialization marker prevents a restart from resurrecting the old
  environment choice after explicit inheritance (`gateway/storage/owner-metadata.ts:291`).
  This is a data migration marker, not a selectable runtime backend.
- Provision or update with `bun open/instance-model-provider.ts <database> <instance>
  <provider|inherit>` after migrating the database (`open/instance-model-provider.ts:9`).
  The writer reports the existing `written`/`unchanged` vocabulary rather than a
  bare success (`gateway/storage/owner-metadata.ts:270`; precedent at :230).
- Read instance and project settings on every resolution, preserving null versus
  explicit Claude (`gateway/wiring/model-provider-resolution.ts:12`). Conversation
  and settings inspection share this resolver (`open/composer.ts:1039`, :5141);
  inspection exposes provenance (`gateway/http/app-projects-surface.ts:1023`).
- Use the dispatched project ID before the active-chat fallback
  (`gateway/wiring/build-llm-call-substrate.ts:695`, `open/composer.ts:1040`).
- Construct build wrappers without requiring an Anthropic pool
  (`open/wiring/substrates.ts:488`, :541; composer fire seam at `open/composer.ts:1146`).
  Build wrappers omit the Responses tool manifest, matching their Claude bridge
  grants (`open/wiring/substrates.ts:505`, :556). The test manifest is nonempty.
- Name the requesting level in the existing pi refusal
  (`runtime/adapters/select-substrate.ts:109`). This remains an ordinary thrown
  Error, not a new error code. Missing OpenAI configuration retains the existing
  nonretryable error event (`gateway/wiring/build-llm-call-substrate.ts:1269`);
  unstamped events become `unknown` in `runtime/errors.ts:77`.

### Evidence and mutation table

Every row was mutated individually, its changed line printed, and its named test
run RED (exit 1), then restored and run GREEN (exit 0). No parser/typechecker
failure counted as mutation evidence. Test aliases: A =
`open/__tests__/instance-model-provider.test.ts`; B =
`gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`; C =
`open/__tests__/open-wiring-substrates.test.ts`.

| Guard / line | Mutation | Test | Mutated / restored |
|---|---|---|---|
| SQL vocabulary, migrations/0148_instance_model_provider.sql:3 | CHECK (1) | A: database refuses | RED / GREEN |
| No-op result, gateway/storage/owner-metadata.ts:275 | condition false | A: live instance changes | RED / GREEN |
| Explicit fresh inherit, gateway/storage/owner-metadata.ts:275 | remove initialized conjunct | A: explicit inheritance | RED / GREEN |
| One-time import, gateway/storage/owner-metadata.ts:291 | = 0 becomes >= 0 | A: legacy provisioning | RED / GREEN |
| Instance precedence, gateway/wiring/model-provider-resolution.ts:13 | instance null | A: live instance changes | RED / GREEN |
| Project precedence, gateway/wiring/model-provider-resolution.ts:14 | project null | A: live instance changes | RED / GREEN |
| Dispatch scope, gateway/wiring/build-llm-call-substrate.ts:695 | omit resolver argument | B: dispatch project chooses | RED / GREEN |
| Refusal provenance, gateway/wiring/build-llm-call-substrate.ts:705 | omit source | B: unwired pi names | RED / GREEN |
| Ephemeral availability, open/wiring/substrates.ts:488 | require Anthropic pool | C: OpenAI-only instance | RED / GREEN |
| Warm availability, open/wiring/substrates.ts:541 | require Anthropic pool | C: OpenAI-only instance | RED / GREEN |
| Ephemeral grants, open/wiring/substrates.ts:505 | use liveAgentProvider | C: project Responses provider | RED / GREEN |
| Warm grants, open/wiring/substrates.ts:556 | use liveAgentProvider | C: project Responses provider | RED / GREEN |
| CLI arguments, open/instance-model-provider.ts:10 | condition false | A: provisioning refuses incomplete | RED / GREEN |

The actual Codex spawn test uses the same captured-Claude filter for zero Codex-path
Claude runs and two positive Claude runs (`open/__tests__/open-wiring-substrates.test.ts:772`).
The earlier test was mislabeled Codex while selecting Responses; its title is corrected
at :751. The old OpenAI-only assertion demanded Anthropic refusal with a valid OpenAI
pool; it now verifies two dispatches (:816), rather than relaxing a valid requirement.

### Validation and limits

- Functional run: 170 pass across A, B, C, `runtime/adapters/select-substrate.test.ts`,
  `gateway/__tests__/app-projects-surface.test.ts`, and
  `gateway/projects/__tests__/sqlite-store.test.ts`. CLI logger follow-up: A, 5 pass.
- Guard run: 102 pass across `tests/integration/identity-env-readers-registry.test.ts`,
  `migrations/runner.test.ts`, `migrations/__tests__/live-ledger-125-repair.test.ts`,
  `migrations/snapshot.test.ts`, `migrations/__tests__/table-ownership-conformance.test.ts`,
  and `scripts/__tests__/spec-items-index.test.ts`.
- `bun run typecheck` reports no script. `bash scripts/ci/typecheck-all.sh` checked
  51 configurations; only untouched `app/tsconfig.json` failed TS2688 for `@types`.
  Final `bunx tsc -p open/tsconfig.json --noEmit`: GREEN.
- `bash scripts/ci/lint.sh`: GREEN after using the repository logger for CLI output.
- Leak gate: INCOMPLETE, zero findings from executed rules; private denylist inputs
  were unavailable. No network, push, PR creation, or merge was attempted.
- Before adding this record, corrected false fallback prose was searched across the tree with
  `rg -n 'degrade LOUDLY to Claude Code|degrades LOUDLY to Claude Code|stay Claude Code regardless|Build provider capabilities once' . --glob '*.ts' --glob '*.md'`.
  The sole match was the positive control at `open/composer.ts:1033`. This record
  now quotes the search terms solely to preserve that evidence.
- Migration 0148 was selected by enumerating local `migrations/[0-9]*` paths; applied
  expectations and the schema snapshot were updated. Concurrent allocation outside
  this checkout cannot be established without network access.
- Deliberately did not replace the native Workflow launcher, implement Codex OAuth
  provisioning, redesign adapter tool transport, or claim full #869 acceptance.
