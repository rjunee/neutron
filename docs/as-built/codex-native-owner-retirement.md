## 2026-09-26 — Fence native Codex retirement and require exact process exit

The broker's ordinary idle state did not constitute permission to retire its
app-server: parent completion could coexist with native children, background
terminals, queued work or goals. `project-control-broker.ts:350` now supplies a
host-only preparation lease which excludes gateway and socket requests, approval
replies and native review transactions while the owner is inspected. An aborted
lease admits the existing owner again. A lease is single-use and rechecks its
census before delivering shutdown.

`runtime/adapters/codex-cli/persistent/project-control-retirement.ts:25` exhausts
native pagination and refuses malformed or repeated cursors. The census reads
loaded thread identities, full turn history, correlated child start/completion
records, session and parent lineage, background terminals, queues and goals.
Child notifications are retained before project filtering; a child missing from
the authoritative census remains unknown. Native activity during either census
invalidates the sample. Unknown schemas and unsupported reads refuse retirement.
Census deadlines reject only the read and preserve the existing owner; uncertainty
does not authorize the ordinary mutation-timeout shutdown path.
The thread identifier and nullable rollout path are preserved as resume facts;
the primitive neither archives nor deletes transcript history.

`runtime/adapters/codex-cli/persistent/project-control-broker-transport.ts:34`
captures the spawned child's process identity and resolves its exit promise only
on that child's exit event. Sending SIGTERM is not a receipt. The broker records
an unresolved retirement marker before signaling, clears it only after exact
exit, and returns discriminated retired, busy or unknown results. Exit timeout
retains the recovery marker.

The consuming owner lifecycle now distinguishes frontend detach from explicit
retirement. `open/wiring/codex-owner-binding.ts:355` fences host admission and
refuses admitted work before asking the helper to retire. An empty frontend
cache is not absence: durable generation records are inspected without creating
an owner, and only ENOENT means absent; inaccessible successor journals remain
unknown. Completed receipts are recovered before refreshing a possibly closed
frontend, so a late helper completion after a lost reply can converge on retry.
General's null scope remains distinct from a project literally named `general`.

`runtime/adapters/codex-cli/persistent/project-owner-retirement.ts:48` corroborates
the completed receipt against the immutable host attestation and positively
proves native, terminal and helper process death. A signal or unreadable process
identity does not permit replacement. The helper reserves retirement before
native shutdown and publishes completion only after native and TUI exit; its own
exit is corroborated by the next reader. Bootstrap suppresses ordinary disconnect
shutdown while the broker is collecting its exact exit receipt.

`open/wiring/codex-durable-owner.ts:35` follows immutable generation receipts,
reserving each successor independently while retaining all prior authority and
launch records. Native resume uses the exact prior thread, session and rollout;
its response is corroborated by independent native thread readback because cold
resume does not emit `thread/started`. Interrupted launches remain reserved.
Broker and helper socket paths stay bounded in the original home. A new binding
revision invalidates old grants; native-child authority and the root installed
MCP route survive native resume. A never-used owner without a materialized
rollout refuses retirement rather than silently starting a replacement thread.
This change supplies `retireScope` for the separate workspace lifecycle consumer;
it does not claim that consumer or the entire workspace spec is delivered.

Validation: the five focused broker, retirement, transport, recovery and bootstrap
test files passed 39 tests with 203 assertions before the census-timeout control
was added; the expanded retirement file passed nine tests with 52 assertions.
They include a real disposable
process that delays exit after SIGTERM, socket and gateway refusal followed by
successful re-admission, pending reads, stale epochs, late child/shell activity,
and durable recovery-marker controls. Two must-fail mutations were exercised and
reverted: suppressing shell refusal failed both direct and second-page shell
tests; refusing the clean census failed its accepting control. The restored
implementation passed the focused set. Integrated host-focused binding, durable
owner, bootstrap, receipt and broker retirement tests passed 106 tests with 1,170
assertions. They include a missing frontend with a live durable owner, a lost
reply preceding a late completed receipt, real helper liveness refusal followed
by safe permitted recovery, and independent General/project admission fences.
Removing receipt process-death checks made the live-helper regression fail.
Over-refusing an otherwise proven completed retirement failed the accepting
control. Replacing strict absence with `existsSync` failed the real inaccessible
successor control by returning absent instead of unknown. All mutations were
restored. Both root and Trident TypeScript checks passed. The consuming Open
build E2E suite passed 331 tests with 3,985 assertions on the host (419.60 seconds).

The disposable native `project-owner-retirement.smoke.ts` passed against a local
synthetic provider: active-turn denial, cold no-rollout refusal followed by a
working turn, exact process exit, immutable predecessor, same-thread/session
resume, retained transcript prefix and prior user input, and resumed native
collaboration plus the installed root MCP tool. Its fixture-only migration-notice
acknowledgement prevents native onboarding from blocking the test. It does not
use a live account or workspace. Live retirement is not claimed by these
disposable receipts.

The admitted `bash scripts/check-shared-host.sh` run started on the clean
implementation revision `7ed219f417381213511b3ffecb5a01ab440b3896`, tree
`337173fad98fa4e6f2b04545dbfda2301e4ccfd2`, on 2026-09-26 after the preceding
shared-host run released admission. The retained start observation binds that
revision to the run; the log itself does not embed a Git identity. Recovery
confirmed the same clean revision and tree and the log's terminal receipt:
all 51 TypeScript projects passed, and all 1,695 declared, discovered, assigned
and executed test files passed across 18 bounded-memory lanes with zero failed
lanes. The wrapper ran `bash scripts/ci/typecheck-all.sh` followed by
`bash scripts/run-tests.sh`, with jobs=4, chunk-size=100 and runner-default
concurrency. This receipt documents that implementation revision; adding this
record does not transfer the local measurement to another revision. Final
publication-head CI remains required before merge.

Independent adversarial review returned GO after the strict ENOENT/EACCES
absence controls and delayed completed-receipt recovery were verified; its
five targeted tests passed with 64 assertions. The archived base and candidate
leak scans each reported the same 451 baseline findings, so neither is claimed
as a clean full-tree purity receipt.

Recovery also reran `bun run
runtime/adapters/codex-cli/persistent/project-owner-retirement.smoke.ts` against
the same unchanged implementation using the disposable synthetic provider.
It exited zero with both retired receipts and the native busy-refusal,
exact-exit, immutable-predecessor and same-thread-history accepting controls.

Publication CI caught the transport's bare discarded exit-proof promise in the
fire-and-forget guard. Its observer now uses the standard logging wrapper while
the original exit promise remains available to retirement callers. The shared-host
receipt above predates that observer change and is not claimed for it.
After the correction, the transport and retirement files passed ten tests with
60 assertions, the disposable native retirement/resume smoke passed again,
the runtime TypeScript project passed, and the complete lint script exited zero.

The refreshed admitted `bash scripts/check-shared-host.sh` run then tested clean
revision `7af3c061f3feb123100b2d5dcc9ce042922c504d`, tree
`78956e0e35041ca0a539afa61a4805f194038508`, after explicit release of the prior
shared-host slot. Start and terminal observations confirmed that exact clean
identity. The original wrapper exited zero: all 51 TypeScript projects passed,
and the final coverage audit matched all 1,695 declared, discovered, assigned
and executed files across 18 lanes with zero failed lanes. Commands and tuning
were the same admitted wrapper profile recorded above. This receipt includes
the corrected exit observer; the subsequent publication change adds only this
documentation. Independent bounded review of the observer delta returned GO,
and all required remote checks passed on `7af3c061f`; publication-head checks
must still finish on the final receipt commit before merge.
