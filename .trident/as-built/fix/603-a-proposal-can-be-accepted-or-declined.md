## Issue 603 — a skill proposal can be accepted or declined

### What changed

Skill Forge notifications now arrive as durable reply prompts carrying Approve, Edit, and Decline controls (`open/composer.ts:1323-1329`). The controls use compact opaque values and accept only a value that was actually offered to the owner (`skill-forge/proposal-controls.ts:15-31`). The production composition root chains them into the pre-model deterministic decision seam (`open/composer.ts:5564-5575`; `gateway/wiring/build-live-agent-turn.ts:1248-1269`).

Approve and Decline call the same `SkillForgeBackend` already shared by chat commands and agent tools (`skill-forge/proposal-controls.ts:47-55`; `skill-forge/backend.ts:18-42`). Approve therefore writes the native skill and marks the proposal approved; Decline marks it declined without writing a skill. Edit deliberately leaves the persisted proposal pending and points to the existing rename-capable approval command (`skill-forge/proposal-controls.ts:39-44`). The continuous source of truth remains the three-state proposal row: creation writes `pending`, and decision updates accept only pending rows (`skill-forge/proposals-store.ts:61-70`; `skill-forge/proposals-store.ts:136-155`).

### Decisions

The existing reply-button transport was reused because it persists options before live delivery (`gateway/http/deliver.ts:382-395`). No parallel approval store was introduced: the proposal table already distinguishes pending, approved, and declined, while the shared backend already owns both effects (`skill-forge/proposals-store.ts:126-145`; `skill-forge/backend.ts:34-42`).

The generic pre-model capture vocabulary was renamed from a ritual-specific name because it now dispatches three disjoint token namespaces. Its default for an unmatched token is `null`, which continues the normal turn; a matched decision returns a deterministic reply and stops model dispatch (`gateway/wiring/build-live-agent-turn.ts:760-776`; `gateway/wiring/build-live-agent-turn.ts:1261-1294`). Errors from a matched proposal decision are converted into an explicit response, so an opaque decision token does not fall through to the model (`skill-forge/proposal-controls.ts:47-59`).

### Evidence and tests

The production test enumerates the persisted options from the real `button_prompts` row selected by the proposal idempotency-key namespace and asserts the complete ordered labels (`open/__tests__/open-skill-forge-wiring.test.ts:146-155`; `open/__tests__/open-skill-forge-wiring.test.ts:226-228`). Backend tests exercise real proposal persistence and real skill-file registration: approve, repeat-answer, decline, edit/pending, offered-value membership, and owner authorization (`skill-forge/__tests__/forge.test.ts:156-207`).

| Guard | Mutation | RED evidence | Restored GREEN |
|---|---|---|---|
| Approve routes to approve | `proposal-controls.ts:49` routed to decline | expected `approved`, received `declined` | specific tests: 19 pass |
| Decline routes to decline | `proposal-controls.ts:54` routed to approve | expected `declined`, received `approved` | specific tests: 19 pass |
| Only offered opaque values resolve | `proposal-controls.ts:31` condition inverted | unoffered Edit returned a response instead of null | specific tests: 19 pass |
| Owner-only decision | `proposal-controls.ts:32` condition inverted | guest received Edit response instead of refusal | specific tests: 19 pass |
| Delivery carries controls | `open/composer.ts:1325` changed from reply to inert | production row query returned zero instead of one | specific tests: 19 pass |
| Opaque namespace gate | `proposal-controls.ts:30` condition inverted | offered control returned null and eligibility test failed | specific tests: 19 pass |

`bash scripts/ci/typecheck-all.sh` checked all 51 TypeScript configurations and passed. `bun test skill-forge/__tests__/forge.test.ts open/__tests__/open-skill-forge-wiring.test.ts gateway/wiring/__tests__/build-live-agent-turn-ritual-approval.test.ts` passed 19 tests with 85 expectations.

### Deliberately not changed

The chat command and agent-tool APIs were not duplicated or replaced; they remain parity surfaces over the shared backend (`skill-forge/backend.ts:2-11`). Edit does not silently approve: it retains pending state until the existing command receives the edited name (`skill-forge/proposal-controls.ts:39-44`). No feature flag, migration, second lifecycle, or auto-approval path was added.
