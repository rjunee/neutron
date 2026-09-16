## 2026-09-16 — Codex rendered prompts reach the bounded worker

### What changed and evidence

The session host registers a screen classifier at
`runtime/adapters/codex-cli/persistent/project-session.ts:216`, using the same
options for attach and spawn at :233, :236 and :240. The classifier recognises
four approval titles, numbered allow/deny choices, and a separate trust dialog
(`runtime/adapters/codex-cli/persistent/screen-prompts.ts:20`, :26, :34).
The screen callback replaces the observation on every delivery, including an
unrecognised screen (`runtime/adapters/codex-cli/persistent/project-session.ts:216`).

Allow and deny share the existing serialized, acknowledged, bracketed-paste path
(`runtime/adapters/codex-cli/persistent/project-session.ts:129`, :139, :143, :165).
An answer captures the prompt object and checks its identity after the queue
wait, immediately before submission (:130, :135, :157, :159). Replacement by trust,
a different approval, or an unrecognised screen refuses the answer. The queue
releases even on refusal (:166). This check is host-owned; it does not depend on
the Codex process cooperating. Conservative identity comparison also refuses an
answer if a repeated screen delivery replaces its object while it waits.

The production worker capability includes screen observation and approval
answers (`runtime/workers/codex-acting-turn.ts:15`). Before dispatch and during
trailer polling, it recognises trust separately and denies approval explicitly
(:48, :65, :71). The denial is deliberate: bounded workers cannot request owner
decisions (`runtime/bounded-work.ts:86`). A rendered menu carries no structured
proof that escalation fits the granted scope. The worker returns a refusal after
denial; it does not continue issuing keys to the same screen (:54, :59).

### Outcome vocabulary and decisions

`CodexScreenPrompt` is `approval` or `trust`, with `undefined` for unrecognised
screens (`runtime/adapters/codex-cli/persistent/screen-prompts.ts:3`, :32, :36).
Directly answering an unrecognised screen throws the existing unknown error;
trust and queued replacement throw `CodexApprovalRefusedError`
(`runtime/adapters/codex-cli/persistent/project-session.ts:103`, :131, :133, :160).
Successful answers resolve; refusals reject, so they cannot be mistaken for success.

The worker maps that typed refusal to the existing `refused` /
`capability-unsupported` vocabulary (`runtime/workers/codex-acting-turn.ts:28`,
:56). Other errors are rethrown (:57). `ProjectActingTurn` already distinguishes
refusal, unknown and turn completion (`runtime/workers/project-runners.ts:31`);
its runner preserves explicit refusals rather than treating them as completion
(:134, :146). Unrecognised screens continue ordinary trailer observation and
ultimately produce unknown on expiry (`runtime/workers/codex-acting-turn.ts:61`,
:74, :82). No new product decision or owner approval protocol is introduced.

The brief's discarded-callback citation :148 and the prior record's :187 were
stale. `git show origin/main:runtime/adapters/codex-cli/persistent/project-session.ts`
with numbered output shows the old empty callback at :189 on the locally available
base. No ref was fetched in this offline lane. Current registration is :216.
A whole-tree Markdown search for `discarded callback|prior empty callback|stale approval`
found this record plus unrelated merge-review discussions; those remain unchanged.

### Regression and mutation evidence

The initial two-file run reproduced **56 pass / 2 fail**. The failing new
assertions incorrectly expected bare keys; they now assert framed bytes
(`runtime/adapters/codex-cli/persistent/project-session.test.ts:303`).
The held-queue test at :306 changes the screen during the wait; before the fix
it failed with actual result `answered` (**34 pass / 1 fail**). It now verifies
refusal, no stale key, and usable queue after refusal (:320).

Worker integration fixtures use the real session host's registered callback,
then invoke the acting turn and assert exact denial bytes or no trust input
(`runtime/workers/codex-acting-turn.test.ts:163`, :179, :184, :186, :193).
The typed refusal mapping and cancellation controls are at :199 and :207.
Allow and deny are both tested through the session at
`runtime/adapters/codex-cli/persistent/project-session.test.ts:287`; the bounded
worker intentionally selects deny only.

Every mutation below ran this exact scoped command, then restored the file and
reran it: `bun test runtime/adapters/codex-cli/persistent/project-session.test.ts runtime/workers/codex-acting-turn.test.ts`.
All restored runs were **65 pass / 0 fail**. The mutation driver printed the
actual changed line before each run. Locations below are repository-relative;
S = `runtime/adapters/codex-cli/persistent/project-session.ts`,
D = `runtime/adapters/codex-cli/persistent/screen-prompts.ts`,
W = `runtime/workers/codex-acting-turn.ts`.

| Guard | Printed mutation location and replacement | RED failures | Restored |
|---|---|---:|---|
| Cancellation after observation | W:67 remove expiry check; next line is JSON comment | 1 | 65 green |
| Paste framing | S:165 `await submit.call(this.child, line)` | 7 | 65 green |
| Queued prompt identity | S:159 `if (false)` | 1 | 65 green |
| Screen registration | S:216 `screenPrompt = undefined` | 9 | 65 green |
| Current screen replaces old | S:216 append `?? screenPrompt` | 1 | 65 green |
| Deny selection | D:35 `const denyKey = allowKey` | 5 | 65 green |
| Trust classification | D:22 return approval with continue key | 4 | 65 green |
| Approval title | D:32 `if (false) return undefined` | 1 | 65 green |
| Complete choices | D:35 append `?? allowKey` | 1 | 65 green |
| Direct trust refusal | S:133 `return` | 1 | 65 green |
| Worker denial policy | W:54 `await session.answerApproval('allow')` | 2 | 65 green |
| Worker trust refusal | W:50 `if (false)` | 2 | 65 green |
| Pre-dispatch observation | W:65 `const initialPrompt = undefined` | 4 | 65 green |
| Polling observation | W:71 `const approval = undefined` | 2 | 65 green |
| Typed refusal mapping | W:56 `if (false) return refuse(String(error))` | 1 | 65 green |

### Verification and boundaries

The root `bun run typecheck` reports `Script not found "typecheck"`; the
repository matrix is the replacement verification command.
`bash scripts/ci/typecheck-all.sh` passed all 51 projects. A separate
`bunx tsc -p runtime/tsconfig.json --noEmit` passed after restoring all mutations.
The final scoped test run passed 65 tests with 150 assertions;
`git diff --check` passed. `bash scripts/ci/lint.sh` passed all gates on the final tree.

This change does not automatically accept directory trust or grant escalation
from bounded work. It does not add a decision callback without a production
owner. Live denial, live trust setup, prompt variants outside the classifier's
four titles, and load behaviour were not measured in this offline lane.
The session and worker fixtures prove the callback-to-decision seam, not the
behaviour of a credentialed external CLI. Only scoped test files were run.

The local leak gate returned exit 3: zero findings from executed rules, but
`pii-denylist` and `pii-denylist-msg` could not run because the private denylist
was unavailable. This is incomplete verification, not a clean leak-gate result.
