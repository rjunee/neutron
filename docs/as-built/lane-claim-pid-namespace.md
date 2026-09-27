## 2026-09-27 — Bind lane liveness to its PID namespace

A claimed Bun invocation containing `open/__tests__/project-build-e2e.test.ts`
and `open/__tests__/route-slot-coverage.test.ts` exited 143 during the real
composer startup. The outer lane owner remained alive and reported no received
signal, foreground exit 143, and confirmed cleanup. The startup reaper calls
the independent sweep (`trident/worktree-reaper.ts:1898`), whose dead-owner path
sends TERM through a pidfd (`trident/lane-processes.py:141`, `:155`). The inherited
claim's PID belonged to the parent namespace; interpreting that number against
private `/proc` incorrectly established owner death.

Claims now include their PID namespace (`trident/lane-processes.py:246`). Owner
liveness checks that namespace before inspecting boot, PID or start time
(`trident/lane-processes.py:60`). The process's own `NSpid` tuple establishes that
the proc mount addresses its active namespace (`trident/lane-processes.py:34`).
Foreign, unreadable and legacy namespace evidence preserves children as unknown.
Legacy claims remain recognized census identities. Exact-claim teardown remains
independent of liveness inference (`trident/lane-processes.py:138`). The existing
dead-lane specification records this distinction.

The regression in `trident/lane-processes.test.ts:19` runs selected cases from
both consuming files under an actual parent-namespace claim and without a claim.
Both the outer test and nested consumer have private PID boundaries, so even a
mutated reaper cannot signal host processes. Python controls retain same-namespace
dead-child cleanup, preserve foreign and legacy claims in the census, exercise
real private versus ancestor proc mounts, and admit claim minting when another
UID's PID 1 namespace is unreadable (`trident/lane-processes-test.py:201`, `:226`,
`:240`, `:257`). A separate host-user check confirmed real claim minting and
inheritance while PID 1 metadata was permission-denied; that read/mint check
replaced cleanup with a no-signal observation.

Validation:

- The full affected two-file pair passed **362 tests, zero failures** both with
  and without the outer claim. The claimed owner's final receipt recorded
  foreground exit 0, no received signal, and confirmed cleanup. The safe claimed
  reproduction is:

  ```sh
  python3 -B trident/process-test-isolation.py -- \
    python3 -B trident/lane-processes.py run -- \
    python3 -B trident/process-test-isolation.py -- \
    bun test open/__tests__/project-build-e2e.test.ts \
    open/__tests__/route-slot-coverage.test.ts --timeout=15000 --max-concurrency=4
  ```

- Final `bun test trident/lane-processes.test.ts
  trident/process-test-isolation.test.ts --timeout=15000`: **10 pass, zero fail**,
  including the Python lifecycle proofs and both consuming controls.
- The real Codex claim-policy and unsupported-ownership cases: **2 pass, zero
  fail**. `bunx --no-install tsc -p trident/tsconfig.json --noEmit` passed.
- Disabling the namespace comparison made the claimed consumer fail with exit
  **143** while its unclaimed control passed. Disabling independent dead-owner
  cleanup failed both the socket-child and escaped-grandchild assertions.
  Restored focused source passed. Mutations ran only inside test containment.

These are focused regression results; full repository gates and deployment are
separate checks. Namespace identities are liveness evidence, not authority to
signal through a different process view. Existing claims lacking that evidence
remain visible with unknown owner liveness until their original lifecycle ends.

The first complete shared-host gate at `6bf99ae4` passed all 51 TypeScript
configurations and executed all 1,727 declared files across 18 settled lanes,
but exited 1: 14 copied host-suite report fixtures could not resolve the logger
workspace package. This was not a full-suite pass. The fixture previously linked
only the Trident-local dependency directory, losing production's ancestor
workspace resolution. `trident/host-suite.test.ts:19` now resolves the logger from
the production module's directory and links only that package into its temporary
fixture. Assertions and production behavior are unchanged. The focused host-suite
run passed 26 tests; deliberately breaking the logger link failed its positive
control, and restoration returned all 26 tests to green. Independent review
approved this fixture correction. A corrected complete gate remains required.

The corrected complete gate subsequently passed at clean source revision
`76c9e96344dbb1d28e6c2b92983de14287dc82f2`:
`python3 -B trident/process-test-isolation.py -- bash scripts/check-shared-host.sh`
exited 0 under the ordinary host identity and private PID/proc containment.
All 51 TypeScript configurations passed, including root and Trident. The coverage
audit recorded 1,727 declared, Bun-discovered, assigned and executed files
(1,491 general, 22 database, 43 device and 171 real-HTTP), across 18 settled lanes
with zero failed lanes. It included the consuming project-build E2E and corrected
report-fixture positive control. Source aggregate
`a93fdd6b1bc58e628e1f95b38b7412398b71af1d24f68260a4dbbd668f4fae03`
and clean HEAD were unchanged before and after. The full log SHA-256 is
`f3231b803953ed934be54e63d54e1081674ddd44b74060b4bc9a60091656a56b`.
Optional external-provider, PTY and system-manager cases explicitly skipped by
the suite remain unverified by this receipt. This final receipt-only addition
does not transfer local evidence to a different source identity; exact publication
head CI, deployment and a fresh unattended live build remain separate gates.

Publication CI at `66f18e7a` subsequently failed the already-cancelled stalled
transcript-open regression: the second submission was present, but its release
count was sampled before completion. The test raced that completion against
40 ms, asserted two releases, and only then awaited the second turn. The test
now awaits the same completion before inspecting its release receipt, while
the first transcript operation remains blocked. Both original turn budgets and
all unknown/cleanup assertions remain unchanged; production code is unchanged.

A controlled 80 ms delay in the second result read reproduced the old assertion
failure (two releases expected, one observed). The causal assertion passed all
seven stalled-transcript cases under that same delay. Suppressing the first
slot's release still failed the second completion assertion within its original
1,000 ms budget. Restored source passed all 93 acting-turn tests with 398
assertions, and both runtime and root TypeScript checks passed. This necessary
test correction requires renewed complete-gate and publication CI evidence;
the earlier complete receipt does not cover this changed source.

Renewed complete validation passed on clean tested revision
`7a114b7e93780794018757f9f6a56b0651d05643` with actual exit zero:
`python3 -B trident/process-test-isolation.py -- bash scripts/check-shared-host.sh`.
The verified private PID/proc boundary ran as the physical unprivileged identity.
All 51 TypeScript configurations passed, including root and Trident. All 1,727
declared, Bun-discovered, assigned and executed test files completed across
18 green lanes: 1,491 general, 22 database, 43 device and 171 real-HTTP files.
The consuming project-build E2E and corrected already-cancelled transcript case
both executed successfully. The before/after source aggregate remained
`83cf8ff489a125580e612b461407329f5bf95891ed310f8ae56bb3a26a86e13f`.
The complete log SHA-256 is
`9b95f916de6bdf98a5a51112a80fcdb5c4bb6f3584aa8582cd9c1eb382be7c25`.

Independent native review and a bounded one-turn Fable review approved the
causal fixture correction. This final receipt addition is not a transfer of
the tested identity: exact publication-head CI, deployment controls and the
fresh unattended live merge still remain to be proved.
