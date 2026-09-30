## 2026-09-30 — Sign the queued native child's original execution deadline before input

Integrating bounded writer-queue credit with native quota continuation exposed
two incompatible clocks. The runner credited a measured, timely writer wait,
but Open had already signed the earlier admission wall and armed a continuation
timeout against that wall. A real queued synthesis could therefore encounter
quota inside its execution allowance and still be refused continuation.

Open now snapshots the observed parent and establishes its single original
signed authority synchronously at submission intent, after bounded queue
admission and before terminal input (`open/wiring/project-build.ts:609`). The
actor records that intent before ending admission preparation
(`runtime/workers/claude-acting-turn.ts:305`). Known pre-input refusals still
record signed `not-submitted` evidence. Receipt failure prevents input; unknown
submission retains ownership. The consuming continuation timer reads the
authenticated original deadline (`open/wiring/project-build.ts:812`). Recovery
and successors retain that deadline; no signed deadline is extended after
launch and no quota claim is refunded.

The governing requirements remain
`docs/spec-items/claude-same-agent-continuation.md:102` and `:139`, the finite
budgets and preserved gates in `docs/spec-items/trident-build-efficiency.md:248`,
and the locked pivot's existing merge gates. No normative criteria changed.

The consuming regression uses the real REPL writer queue: a 1.2-second held
writer on a two-second synthesis budget, followed by authenticated quota after
the former admission wall. It failed before the integration fix and now reaches
the existing merge gates with one original child and one continuation. Its
paired spent-execution case retains the original lease and refuses input when
capacity returns too late. Cancellation and expired queue admission dispatch
nothing, while completed original work remains recoverable without redispatch
(`open/__tests__/project-build-e2e.test.ts:7540`).

Focused validation: 25 consuming cases, 169 dispatch/budget/receipt/lease cases,
and 61 native-continuation cases passed. Root, Trident and Open TypeScript checks
passed. An inherited logical-clock fixture now uses its own clock for queue
measurement instead of adding real scheduling jitter to synthetic time.
Bidirectional semantic mutations failed as required: an extra signed execution
allowance incorrectly merged the spent-budget case, while restoring the old
prequeue clamp blocked the lawful queued continuation. Both mutations were
restored before the final consuming checks.

This is offline integration evidence. Independent review, the complete consuming
file and full repository validation on the final integration head, publication,
deployment, and real provider quota acceptance remain separate. No live runtime
state, capacity, account selection, or durable production lease was changed.
