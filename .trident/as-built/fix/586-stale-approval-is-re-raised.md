## 2026-09-14 — Forgotten ritual approvals re-raise at a bounded daily cadence (#586)

### Change and evidence

The approval store owns the named daily interval and three-attempt cap
(`tools/approval.ts:69`). It persists reminder count, last attempt time, and
expiry reason on the original grant, preserving other arguments
(`tools/approval.ts:206`). Missing, unreadable, negative, or future age data and
invalid reminder counts expire with a reason rather than becoming fresh
(`tools/approval.ts:219`).

The ritual service enumerates `listPending(project_slug)` and filters the two
ritual grant namespaces; it verifies the original content hash and renders fresh
buttons carrying the original token (`reminders/ritual-registration.ts:750`).
Content and egress remain separate (`reminders/ritual-registration.ts:766`).
The composer registers a supervised minute sweep, starts it immediately, defers
while onboarding, and awaits its stop during cleanup (`open/composer.ts:3199`).
This mechanism runs without an agent turn or a working model response. The
existing loop supplies single-flight execution and error supervision
(`loop/index.ts:258`), and periodic timer registration (`loop/index.ts:247`).

The answered-approval invariant is maintained at the store boundary: owner
answers share serialization with reminder reservation and delivery
(`tools/approval.ts:171`). Delivery queues separately, giving answers queued
during reservation precedence, then rechecks pending state before invoking the
surface (`tools/approval.ts:240`). An answer during an already-started delivery
waits for that delivery to settle. The regression at
`tools/approval.test.ts:381` first went red against a single reservation/send
operation, then green after splitting the operations.

### Decisions and outcome vocabulary

The owner supplied 24 hours and three re-raises: a week would arrive after gated
work was stale; a fourth identical reminder would become noise. Those reasons
sit beside the named constants (`tools/approval.ts:69`). The third reminder gets
one final daily response window; expiry occurs at the next due boundary
(`tools/approval.ts:221`). This avoids emitting an already-expired third prompt.
The decision is recorded in `SPEC.md` (2026-09-14, #586), with acceptance in
`docs/spec-items/stale-approval-is-re-raised.md`.

Expiry joins the existing `ApprovalDecision` value `expired`
(`tools/approval.ts:28`); waiters resolve with that value, and the row remains
with `expiry_reason` (`tools/approval.ts:228`). Ritual status now reports
`expired` and the reason (`reminders/ritual-registration.ts:1097`). The boot
sweep's existing non-`none` default skips it, preventing automatic resurrection
(`reminders/bundled-ritual-enable.ts:209`). The new operation returns explicit
`skipped`, `raised`, or `expired` outcomes (`tools/approval.ts:209`); the ritual
sweep needs no further action for these outcomes and catches delivery errors
per row (`reminders/ritual-registration.ts:779`).

A reservation survives a crash or delivery failure and consumes its attempt
(`tools/approval.ts:237`). This chooses a durable noise bound over retrying an
uncertain send. Explicit owner-requested reapproval remains available; the
automatic path does not mint replacement grants. Unrenderable or changed
original content expires with a reason (`reminders/ritual-registration.ts:759`).

### Verification and mutation table

Every row below was tested individually: print the exact mutated landing line,
print `git diff -- <file>`, run the tests to RED, restore the file, and run the
same tests to GREEN. The first fifteen use
`bun test tools/approval.test.ts reminders/ritual-registration.test.ts`.
The last two use `bun test open/__tests__/open-bundled-ritual-enable-wiring.test.ts
-t 'production age sweep'`. Mutation logs were kept outside the repository.

| Guard and landing | Mutation | Red test | Restored |
|---|---|---|---|
| answer serialization (`tools/approval.ts:195`) | Run work without the shared queue | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| pending selection (`tools/approval.ts:212`) | Remove initial pending check | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| valid age and history (`tools/approval.ts:219`) | Force validation true | unknown or impossible request age expires: unreadable | GREEN |
| daily interval (`tools/approval.ts:221`) | Invert age comparison | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| three reminder cap (`tools/approval.ts:223`) | Remove cap comparison | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| expiry branch (`tools/approval.ts:224`) | Invert null-send condition | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| expiry pending update (`tools/approval.ts:229`) | Invert pending SQL predicate | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| post reservation pending (`tools/approval.ts:244`) | Remove final pending check | answer queued during reservation wins before delivery starts | GREEN |
| durable reservation (`tools/approval.ts:237`) | Write zero count and time | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| ritual scope (`reminders/ritual-registration.ts:753`) | Invert namespace-match guard | reuses actionable grant tokens, preserves egress separation, exposes expiry | GREEN |
| renderable definition and schedule (`reminders/ritual-registration.ts:759`) | Invert definition/schedule guard | reuses actionable grant tokens, preserves egress separation, exposes expiry | GREEN |
| original content hash (`reminders/ritual-registration.ts:765`) | Remove hash comparison | unrenderable original prompt expires with reason | GREEN |
| egress separation (`reminders/ritual-registration.ts:766`) | Invert egress discriminator | reuses actionable grant tokens, preserves egress separation, exposes expiry | GREEN |
| reserved outcome (`tools/approval.ts:240`) | Invert callable-outcome guard | daily boundary, concurrent sweeps, restart, three reminders then retained expiry | GREEN |
| expiry vocabulary (`reminders/ritual-registration.ts:1097`) | Remove expired-row classification | reuses actionable grant tokens, preserves egress separation, exposes expiry | GREEN |
| supervised startup (`open/composer.ts:3210`) | Remove loop start | production age sweep re-raises stale grants and retains expired ones across boot | GREEN |
| onboarding suppression (`open/composer.ts:3204`) | Remove onboarding gate | production age sweep re-raises stale grants and retains expired ones across boot | GREEN |

The production test observes actual durable prompts and grants across boot,
including onboarding suppression and retained expiry
(`open/__tests__/open-bundled-ritual-enable-wiring.test.ts:323`). Store fixtures
retain the original content-hash argument; answered-row assertions check that
its arguments remain unchanged (`tools/approval.test.ts:379`).

### Scope and limitations

This change does not alter deployment approval policy, auto-approve a grant,
change ritual schedules, or introduce a second automatic path. Runtime state
remains in the approval store; the sweep selects only ritual namespaces
(`reminders/ritual-registration.ts:752`). A send already in flight completes
before a queued answer is applied (`tools/approval.test.ts:402`); delivery is not
retractable. Offline time does not produce a burst of catch-up reminders: the
next reservation records the current time (`tools/approval.ts:237`).

The stale rationale was searched across the tree with a positive control using
`rg --hidden -g '!.git' -g '!node_modules' -g '!**/node_modules/**'
'already in front of him|periodic age sweep|permanently invisible' .`; it finds
the replacement explanation at `reminders/bundled-ritual-enable.ts:204` and
this record's reproduction of the search itself. The Core tool description now
also describes automatic reminders (`cores/free/reminders/package.json:496`).

The lane brief explicitly requires this branch-named staging location, overriding
the repository's default permanent shard location.

### Final local validation

The continuation ran these focused test files, enumerated from the changed
files and their approval consumers:

- `tools/approval.test.ts`, `reminders/ritual-registration.test.ts`, and
  `cores/free/reminders/__tests__/rituals-tools.test.ts`: 80 passed.
- `open/__tests__/open-bundled-ritual-enable-wiring.test.ts`,
  `reminders/bundled-rituals.test.ts`, and `reminders/bundled-rituals.e2e.test.ts`:
  35 passed. Five existing credential-gated tests were skipped by their existing
  condition (`reminders/bundled-rituals.e2e.test.ts:284`); no skip was added.
- `reminders/ritual-approval.test.ts`, `open/__tests__/host-deploy.test.ts`, and
  `open/__tests__/host-deploy-window.test.ts`: 141 passed.

`bash scripts/ci/lint.sh` and `git diff --check` passed. The complete
`bash scripts/ci/typecheck-all.sh` checked 51 configurations. The four changed
packages (tools, reminders, open, and the reminders Core) passed. The matrix is
not green: app cannot find the implicit `@types` definition, and gateway,
onboarding, logger, and root report existing test typing errors at
`gateway/transcription/__tests__/whisper-install.test.ts:186`,
`logger/__tests__/fire-and-forget.test.ts:301`, and
`onboarding/history-import/__tests__/zip-writer.ts:10`. Real TypeScript and Bun
types were verified in node_modules. Saved baseline and restored-change root
compiler diagnostics were byte-identical under `cmp`.

The public leak gate found zero findings among rules that ran, but reported
INCOMPLETE because the private PII denylist was unavailable. This is not a clean
purity verdict. No full test-suite run, network operation, push, PR creation,
or merge was performed for this continuation.
