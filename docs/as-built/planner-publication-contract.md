## 2026-10-10 — Match closed planner instructions to host publication

Two fresh independent planners each attempted to publish a complete result
envelope through the closed planner tool. One then tried the inner snapshot.
Three publication calls were refused before both workers supplied the accepted
plan payload and advanced. The brief told them to write the envelope, while
`runtime/workers/planner-work.ts:293` already constructs that envelope around
the supplied payload and independently measures its Git snapshot.

The three additional submission messages after the first refusals consumed
12,346 output tokens, deduplicated by provider message ID. The two planners took
approximately 32 and 56 seconds from first refusal to accepted publication.
Those are observed retry costs, not a before/after saving measured on the fix.

`open/wiring/project-build.ts:1052` now renders a version-6 closed planner brief
that supplies the plan schema and asks for only that plan as `payload` to
`planner_work.publish`, or a `blocked` reason. It distinguishes result publication
from repository publication. File-writing builders and reviewers retain their
complete envelope instructions. The result validator is unchanged: wrapped
payloads remain invalid, and no automatic unwrapping accepts a worker's snapshot.

Changing instructions cannot rewrite an admitted step's identity. The existing
reservation and retained-proof owners select the earlier version-5 brief only
from authenticated request evidence (`open/wiring/project-build.ts:997`). Its
bytes must still equal the historical rendering of current inputs. It keeps
edit-only, no-network authority (`open/wiring/project-build.ts:1154`). Bare old
files cannot select an older protocol. Versions 2–4 retain their existing
recovery contracts. This is preservation of recorded work, not a second option
for fresh dispatch.

The consuming fixture now distinguishes a worker-written envelope from a closed
planner's host-written envelope. Its real closed-tool path derives the submitted
shape from the delivered publication instruction rather than unconditionally
extracting the correct payload despite contradictory prose. The native planner
case rejects both observed wrapper mistakes without writing a result, then
publishes a legitimate payload and reaches governed merge. Candidate validation
and uncommitted preparation handoff remain required.

The normative criterion is in `docs/spec-items/trident-build-efficiency.md`;
`docs/SYSTEM-OVERVIEW.md` describes the resulting publication boundary.

### Focused evidence

At base `794761bf6818de3a1dea388631c4e1cc3797aa95`, the added consuming instruction
regression failed: zero pass, one fail. Validation uses Bun 1.4.2.

- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern
  'native planner consumes its closed host capability|every dispatched brief states|planner work boundary preserves immutable|bare legacy|legacy v4 planner retains|settled proof-only fix retry retains.*legacy-v[45]'`:
  24 pass, zero fail. This includes version-5 pending recovery and retained
  proof retry without additional planning, changed-input refusals, and missing
  or foreign reservation controls.
- The same file with
  `'historical pending|legacy v2|v2 pending builder reconstruction|legacy planner bindings survive|initial planner chooses'`:
  32 pass, zero fail, covering the affected historical fixtures.
- `bun test open/__tests__/project-build-wiring.test.ts`: 57 pass, zero fail.
- `bunx tsc --noEmit -p open/tsconfig.json`: exit zero.
- `bash scripts/ci/lint.sh`: exit zero.
- Three source mutants were rejected by their targeted consuming cases:
  restoring the wrong publication instructions, losing the retained version-5
  identity, and changing its closed tool grant. Each produced zero pass and one
  fail. Source bytes were restored; both affected positive controls then passed.

These checks prove instruction delivery, strict publication and recovery
behavior. They do not prove model compliance or a measured live token saving.

### Full validation and the retained-result readers

The first `bash scripts/check-shared-host.sh` run tested clean revision
`9c2d571a27849a24df70cd073d331e5cd665d32c`. Lint and all 51 project typechecks
passed. The suite executed all 1,809 files: 28,464 passed, 24 skipped and 21
failed. The gate exited 1 with unchanged suite input identity
`b2c76dad325864e039a4b6ca5b35a7e501a98a7b5b9d4059b64e14f7b6a15f3a`.
This was a regression in the unpublished change, not a full-suite pass.

The affected merge-refusal and settled proof-only retry readers still selected
the version-5 base brief for every closed planner. Thus the earlier-version
focused controls passed while results from the newly delivered version 6 lost
their recovery eligibility. `trident/build-mode-state.ts:282` and
`trident/settled-proof-fix-recovery.ts:111` now select only the exact version-5
or version-6 hosted path pinned by the authenticated worker request. Unsupported
closed versions return no recovery source. Existing provider, permissions,
request journals, input bytes and stable-evidence checks remain in force. The
separate migration of unversioned reservations still refuses closed versions;
the added version-6 control in `trident/project-build-host.test.ts` pins that
boundary.

The consuming proof-only fixture also produces complete settled evidence with
an unsupported version-7 planner and verifies that it cannot authorize retry.
After the correction:

- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern
  'base drift refresh retains terminal task work and renews release evidence|settled proof-only fix retry'`:
  27 pass, zero fail, including all 21 formerly failing cases and legitimate
  earlier-version recovery.
- `bun test trident/project-build-host.test.ts trident/build-mode-state.test.ts
  trident/settled-proof-fix-recovery.test.ts`: 78 pass, zero fail.
- Removing version-6 support from either reader fails its legitimate consuming
  recovery case. Accepting version 7 fails the unsupported-version consuming
  case. Each mutant produced zero pass and one fail; source bytes were restored,
  and all three restored controls passed.

The corrected source still requires a complete shared-host gate, exact-head CI
and deployment. The initial red receipt is retained separately from those
requirements.
