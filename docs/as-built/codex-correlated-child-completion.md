## 2026-09-19 — Correlate delayed native child completion with its dispatch

A same-provider build child can finish after its parent dispatch turn has
completed and the next owner chat has begun. The captured native rollout showed
`SubAgentActivity(started, parent P, child C)`, `task_complete(P)`,
`task_started(Q)`, then `SubAgentActivity(completed, parent P, child C)` before
the user-message echo for Q. The observer rejected that child notification
because its parent turn was P rather than the active owner turn Q. This follows
the one-project REPL and native same-model child contract in the pivot plan
(2026-09-11, lines 87–111); it does not change that contract.

The observer now reconstructs pending child activity from its validated
baseline and records new starts during observation. A completed activity must
match the owner thread and an observed parent-turn, child-thread, and child-path
tuple, which it consumes exactly once. This notification produces no owner
reply, completion, prompt echo, or cancellation authority
(`runtime/adapters/codex-cli/persistent/rollout-observer.ts:243`). Other stale
items retain the current-turn check (`:264`), and owner completion still requires
the active turn and correlated prompt (`:279`). This narrows the item-identity
refusal for a measured native child lifecycle; it does not permit unrelated
history to complete a new turn or authorize another session.

The native-shape regression varies the notification across the baseline,
before the next turn starts, before and after its prompt echo, and after its
completion in the same append (`rollout-observer.test.ts:132`). It checks that
only the next owner's correlated reply is returned and cancellation identity
remains tied to that owner turn. Controls refuse foreign threads, parents,
children and paths; missing or duplicate dispatch evidence; late starts;
unknown stale statuses; and stale user/assistant items (`:166`).

Verification: the original observer failed four valid delayed-notification
cases. With the fix, the focused observer/host bridge suite passes 65 tests and
145 assertions. A semantic mutation that accepts unmatched completions fails
seven controls; a mutation that rejects all child completions fails seven
tests. Both mutations were restored. The captured native sequence supplied the
regression input; another integrated native smoke run, restart acceptance,
and production cutover are not established by these unit tests.

Root and Trident TypeScript checks and focused ESLint pass. The authored-file
release tree and proposed commit message pass the local leak gate. The full
local tree scan reports baseline findings; that is not a clean full-tree
verdict and does not replace CI purity.
