## 2026-09-27 — Codex operator selection and bounded custody adoption

The credential service now owns explicit rotation, cooldown release and adoption
of existing canonical account directories. `trident/codex-credential.ts:1241`
implements named target release without cooling the departure, while unnamed
rotation chooses an eligible successor without adding a departure cooldown.
`:1287` releases one/all slots without moving selection;
`:1308` adopts exact live bytes into encrypted storage without writing auth files.
Identity, duplicate-account, unavailable-grant and ambiguous freshness refusals
precede persistence. Existing labels, expiry and rotation records survive.
Bounded initial metadata can seed a new slot's label/cooling deadline, retain
the default home's selection, and carry forward its usage attribution cutoff.
Existing cooldowns survive repeated adoption and an existing usage cutoff can
only increase; conflicting selection refuses before persistence.

The authenticated HTTP surface derives the owner from bearer authentication and
exposes operator actions plus a read-only stored-pointer view
(`gateway/http/codex-credential-surface.ts:112`). Results distinguish changes,
already-selected/released/adopted states and named refusals. Explicit release
uses the existing harvest throttle so an immediate consuming lookup does not
undo it from an old quota observation; it adds no poller and asserts no remote
token-health verdict.

Synthetic service and HTTP checks cover success and refusal, including both
account homes remaining available and unchanged, finite grant preservation,
owner-boundary routing and cached-state-independent stored selection. Existing
General credential and handoff tests retain idle admission, target viability,
retirement revalidation and explicit project grants. The consuming fixture
`open/__tests__/project-build-e2e.test.ts` includes
"operator-adopted Codex accounts preserve custody and selected home reaches the
merged build". The coordinator ran that new case successfully with 11 assertions,
then the complete consuming file: 357 tests passed, zero failed, 4,663 assertions.
This consuming proof does not replace the complete shared-host release gate.

Focused validation: `bun test trident/codex-operator-custody.test.ts
gateway/http/codex-credential-surface.test.ts trident/codex-credential.test.ts
open/__tests__/codex-account-handoff.test.ts
open/__tests__/general-codex-credential.test.ts` passed 101 tests with 489 assertions.
The spec index checks passed 38 tests with 406 assertions. Root and Trident TypeScript
checks passed during implementation. Deliberately omitting target release,
bypassing freshness, bypassing identity, refusing a valid newer bundle, and
resetting a finite grant, reapplying initial cooldown over an existing slot, and
lowering the usage cutoff each failed the focused regression checks; source was
restored. A concurrent pointer change during persistence produces an explicit
partial-custody refusal and preserves that pointer; its fixture confirms both
the adopted bytes and preserved selection.

Review corrections make plain rotation skip expired/unusable successors while
retaining later healthy candidates, and serialize all three global disconnect
entry points through the same owner queue (`trident/codex-credential.ts:844`,
`:1578`, `:1601`). A real database transaction barrier reproduces the former
disconnect/adopt resurrection ordering; after correction, all three disconnect
surfaces remove custody before adoption reads, and a different owner's operation
completes while the writer is held. Mutants that selected expired grants, refused
a healthy successor, or bypassed disconnect serialization failed the new paired
controls. All mutants were restored. These checks are local implementation
evidence, not exact publication
head CI or live migration evidence. Independent Astra review and bounded Fable
review approved the repaired source. The frozen implementation subsequently
passed the complete shared-host release gate recorded below.

Final local receipt (2026-09-27): tested implementation revision
`0a70e5855b7ed120ed75f1a27df88dfe60529a86`, with a clean worktree before
this receipt edit. `bash scripts/check-shared-host.sh` ran
`bash scripts/ci/typecheck-all.sh` and `bash scripts/run-tests.sh`; the owning
runner confirmed terminal exit 0. All 51 TypeScript configurations passed,
including root and Trident. The coverage audit matched 1,724 declared,
Bun-discovered, assigned and executed files: 1,488 general, 22 PGLite,
43 device and 171 real-HTTP files. All 18 lanes were green with zero failed
lanes. The consuming file `open/__tests__/project-build-e2e.test.ts` was included;
its operator-adopted custody/selected-home merged-build case passed.
This receipt establishes local validation of the named implementation revision.
It does not transfer that validation to the documentation publication head;
exact publication-head CI, deployment and live account adoption remain unproved.

Adoption is limited to existing default/named canonical homes. It preserves
existing Open metadata; offline callers must independently establish legacy
identity/freshness and retain stable old-id-to-slot mapping. It does not move
native homes, guess the owner of old copies, or replace live credentials.
No live account data or credential files were read during implementation.
The older frozen as-built claim that only reconnect clears quarantine describes
historical behavior; SPEC.md's 2026-09-27 decision records explicit release.
