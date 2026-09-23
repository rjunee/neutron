## 2026-09-21 — Preserve measured claim conflicts after a trailer scan exception

G100 requires preservation before refusing a real builder-claim/head disagreement
(`docs/trident-gates-inventory.md:184`). On the candidate based at `ce601b78`,
the advisory trailer scan awaited a host runner inside the outer preservation
catch. A rejected scan therefore returned unknown before the preservation push.

`trident/gates/build-claim.ts:63` now contains exceptions around that scan alone,
using the existing bounded cause helper to report the scan as unmeasured. The
measured object still goes through the lease push and independent remote receipt
at `trident/gates/build-claim.ts:74`; the resulting conflict remains blocked.
Claim validation and preservation failures retain their existing refusals.

The new `trident/gates/build-claim-scan-failure.test.ts:61` exercises real git and
a bare origin through the production lazy credential runner. Loader exceptions
on range listing, raw commit reads and size reads all preserve the exact measured
object, even after the local branch moves. The healthy scan is the positive
control. Equal and absent claims, malformed heads and invalid branch names leave
the remote untouched (`:87`). A subsequent publication scan with the same fault
still returns unknown, while its healthy control allows (`:107`).

Verification: the three build-claim files passed 19 tests; release-readiness
passed 32 tests. Root and Trident typechecks passed. Re-throwing the scan error
made four new regressions fail while the healthy and non-conflict controls
passed. Bypassing claim equality made the non-conflict regression fail while
the other five new tests passed. Restoring both mutations returned all 19
build-claim tests to green. This is local repair evidence; consuming Open E2E,
deployment and live acceptance remain with integration.
