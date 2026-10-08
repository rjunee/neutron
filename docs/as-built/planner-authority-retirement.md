## 2026-10-08 — Retire exact expired planner authority without terminating its parent

An unresolved native planner can retain a durable child lease after its workflow
fails and its original operation grant expires. Missing worktrees, provider
errors and gateway death do not establish task completion. The explicit operator
policy recorded in `SPEC.md` permits retirement of that workflow authority while
preserving the unknown native outcome and the live parent.

The new admin consumer requires both the owner token and an independently pinned
operator signature. It authenticates the original dispatch, request, complete
lease, restricted profile and recorded operational corroboration. That
corroboration is an operator judgment about the retained native invocation and
tool enforcement; it is not relabelled as an original signed native observation.
An expanded profile or a token reserved by host-termination recovery refuses.

Migration 0168 records an immutable scoped run/step retirement before draining
host grants. Admission, continuation, grant construction and operation checks
respect that permanent fence. The local barrier covers constructors already in
flight and waits for accepted operations. Consumption records the evidence and
removes only the exact unchanged lease in one transaction. Retries preserve the
record; unrelated work and all original outcome/result artifacts survive.
Workspace authority is retired separately from task completion. No native input,
process signal, parent replacement or reboot is performed by this operation.

Focused validation passed 48 runtime, consumer and admin-route cases, including
actual Open composition with zero native starts and semantic mutations for
authentication, dispatch identity, drain and disabled legitimate recovery.
Store validation passed 20 cases, including restart persistence, replacement
admission refusal, reservation exclusion, concurrent eligibility and transaction
rollback. Schema and ownership checks passed 19 cases.

The complete shared-host gate at `807d57dd78b778ea4a28285d5d48007960bbc7cc`
passed all 51 typechecks and executed all 1,797 discovered test files. It failed
four fixture cases: three explicit migration lists omitted ordinal 168, and one
process fixture repeated cleanup after its child exited. The lists now include
the new ordinal; both related process fixtures capture the exit promise once and
skip termination after observed exit, retaining their live/dead assertions.

At `e18b493efe6387b6ea5c739483177f79c971be14`, all 51 typechecks and both
original affected 100-file batches passed. The three edited fixture suites also
passed their focused 29 cases. This is affected proof, not a final-head local
full-suite pass. The final publication commit adds this validation record only;
complete CI for that exact head remains required before merge.

Layering checks passed. Local whole-tree privacy scanning reported the existing
baseline denylist findings and untracked linked-checkout metadata; it did not
establish a clean tree scan. Commit/PR preflight and exact-head CI purity remain
required. Independent native and bounded cross-model reviews approved the
implementation; final record review, deployment and live operator recovery remain
pending at the time of this record.
