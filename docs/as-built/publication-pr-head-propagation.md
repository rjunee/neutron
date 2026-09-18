## 2026-09-18 — Bound PR head propagation after a witnessed push

A production retry pushed its new commit successfully and independently witnessed
that exact remote branch head, but publication then stopped on a PR-head mismatch
before review. A subsequent observation showed the PR at the candidate revision;
delayed PR metadata is the supported explanation, but the mismatching response was
not recorded. The production publication effect now allows four delayed
reads (1, 2, 4 and 8 seconds) for that specific stale projection. Fifteen seconds
is a conservative retry allowance for the observed seconds-scale lag, not a
claim about the service's maximum propagation time.

The retry applies only to an open, provenance-bound PR whose head equals the
known pre-push remote lease. Each retry verifies the remote still holds the
candidate and the bound run and local revision have not changed. An unrelated
head, terminal PR, malformed identity, unreadable response, changed pin or
exhausted budget refuses publication. There is one push, no repeated PR create,
and the final PR must still name the exact candidate. The build driver continues
to measure independently after publication; success is not cached as evidence.
A later regressed PR read remains fail-closed and can still stop the run rather
than being masked by the earlier convergence.

This preserves the locked plan's gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265`) and the publication
witness requirements G099/G101 (`docs/trident-gates-inventory.md:183`, `:185`).

Verification: `trident/production-host-effects.test.ts` passed 88 tests, including
zero-wait success, convergence on the final allowed read, exhaustion, incorrect
or terminal observations, remote/local/persisted drift, and both directions of
the driver's independent post-publication measurement.
`open/__tests__/project-build-e2e.test.ts` passed all 61 tests. Both
`tsc -p tsconfig.json --noEmit` and `tsc -p trident/tsconfig.json --noEmit` passed.

Semantic mutations turned the corresponding tests red: removing retries rejected
valid delayed propagation; retrying an arbitrary wrong head accepted a later
response that should not erase the refusal; removing the final head comparison
accepted an exhausted stale head; bypassing the remote witness accepted drift;
and bypassing the run/local pin guard accepted changed local, base and provenance
pins. Restoring the guards returned the regression tests to green. These are
local verification results; deployment and a fresh unattended live merge remain
separate acceptance evidence.
