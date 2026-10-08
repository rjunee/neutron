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
rollback. Schema and ownership checks passed 19 cases. Full consolidated checks,
deployment and live operator recovery remain pending at this candidate.
