## 2026-09-14 — Reap processes left by dead build lanes (#623)

### Change and evidence

The old worktree sweep deliberately did not kill processes. Its replacement
header separates the filesystem pass from the process pass
(`trident/worktree-reaper.ts:5`). A whole-tree search using
`rg -n 'NEVER kills a process|separate process pass uses pidfds' . --glob '!bun.lock'`
found only the new header: the second alternative was the positive control for
the absence of the old claim. The filed header citation also predated the
branch-ref work; this change leaves that existing ref policy alone.

The Codex wrapper enters a separate process owner before starting build code
(`trident/codex-build.sh:434`). That owner mints a random claim and publishes it
in the child's initial environment (`trident/lane-processes.py:163`). The
wrapper pins it into Codex's filtered shell environment
(`trident/codex-build.sh:1382`); Herdr explicitly forwards the spawning process's
claim through its socket request, even for a minimal caller environment
(`runtime/adapters/claude-code/persistent/herdr-host.ts:716`). This covers children
whose parent is the socket server and whose pane never reached a registry.

Normal wrapper completion reaps only its exact claim
(`trident/lane-processes.py:116`, `trident/lane-processes.py:167`). Independently,
the existing gateway reaper loop invokes the process sweep at startup and every
fifteen minutes (`trident/worktree-reaper.ts:1946`,
`trident/worktree-reaper.ts:1951`; gateway composition remains at
`gateway/composition/build-core-modules.ts:629`). The failed build does not run
that tick. Gateway downtime delays cleanup until its next boot.

### Death, identity and scope

The random claim is ownership identity. PID, kernel start time and boot ID are
owner-liveness evidence only (`trident/lane-processes.py:48`). Missing owners,
zombies and a different process incarnation establish death; unreadable boot or
process evidence returns `unknown`. Only `dead` authorizes periodic claim cleanup
(`trident/lane-processes.py:123`). Unknown and live claims cannot fall through to
the removed-directory rule.

Every signal uses a pidfd opened before reading the target's environment. A
post-read readiness check rejects an exited original process even if its numeric
PID now exposes a successor's data (`trident/lane-processes.py:113`,
`trident/lane-processes.py:130`). TERM precedes a bounded batch grace period and
KILL; both signals use the original handle (`trident/lane-processes.py:132`,
`trident/lane-processes.py:149`). No stored PID or process-name pattern addresses
a kill. The module-wide search
`rg -n 'pidfd_send_signal|os\.kill|killpg' trident/lane-processes.py`
finds the pidfd calls as its positive control and no numeric-PID kill primitive.

Unclaimed legacy children use a narrower proof: an actually unlinked cwd beneath
an absent `wf_*` root of a configured repository
(`trident/lane-processes.py:77`). Kernel link count distinguishes a removed cwd
from a live directory literally named with the deletion suffix. An existing or
recreated root, an unreadable root, and a live run's recorded root refuse cleanup
(`trident/lane-processes.py:91`). Gateway enumeration requests all nonterminal
rows for that protection (`trident/worktree-reaper.ts:1964`).

The new missing-support refusal joins the wrapper's existing exit-3 `deferred`
vocabulary (`trident/codex-build.sh:899`); the workflow already maps exit 3 as a
pre-build refusal (`trident/inner-workflow.mjs:2249`). It does not introduce a new
workflow verdict or silently become a code failure. The process report separates
`reaped`, `survived`, `unknown` and `live` (`trident/lane-processes.py:102`,
`trident/lane-processes.py:151`). Host-command errors/timeouts use the existing
logger's error path; they never establish death
(`trident/worktree-reaper.ts:1969`). Linux pidfds/Python 3.9+ are required and
probed before a build starts (`trident/lane-processes.py:181`), with the dependency
recorded in `CONTRIBUTING.md:42`.

### The measured 38 panes and deliberate limits

The report supplied labels and registry absence, not the processes' cwd/owner
measurements. An exact historical count cannot be established from that data.
Of those processes, this implementation reaps those with an unlinked cwd under a
removed, unprotected, configured `wf_*` root. It preserves unclaimed processes in
surviving directories: neither a shared label nor registry absence proves that
another live session does not own them. New claimed children are covered without
ancestry or registry membership (`trident/lane-processes.py:114`).

This change terminates OS processes; it does not delete Herdr pane/tab UI
containers. It does not infer ownership from argv substrings or shared labels.
Commands that replace their entire environment can discard the claim and then
receive only the removed-root backstop. Other builders without the Codex wrapper
receive that backstop, not the claim-based normal-exit cleanup. No process is
killed solely because a workflow row says terminal. No ref-deletion policy or
unrelated cancel-path behavior changed.

### Tests and fixture correction

The real owner-death proof kills a build after it spawns a TERM-resistant
grandchild, observes that the child survived the owner, and then asserts both
remaining processes exit after the sweep
(`trident/lane-processes-test.py:248`). A broker-created child outside the owner
process tree and a second live claim exercise both safety directions in the same
sweep (`trident/lane-processes-test.py:82`). Normal teardown also has an actual
escaped-child proof (`trident/lane-processes-test.py:265`). The Python proofs are
part of Bun test discovery through `trident/lane-processes.test.ts:4`.

Mutation fixtures restrict process enumeration to their own spawned subjects,
while retaining real proc reads, pidfds and signals
(`trident/lane-processes-test.py:28`). A deliberately broken guard therefore
cannot target unrelated host processes. The PID-reuse interleaving uses a ready
original handle with mocked successor evidence and asserts no signal call
(`trident/lane-processes-test.py:173`).

The atomic-trailer observer previously inherited the build's lifetime; correct
teardown killed that observer before its next poll. It now runs as a test
instrument outside the build claim, with every atomicity assertion unchanged
(`trident/codex-build.test.ts:2830`). The existing Herdr exact-env assertion now
includes an ambient lane claim when present, retaining the exact key/value
comparison (`runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts:826`).
The root-permission fixture was also made path-specific after the new cwd-stat
guard would otherwise have intercepted its error before the root probe.

### Mutation table

Every row below produced test exit **1 (RED)** under mutation and **0 (GREEN)**
after restoration. Each mutation's actual changed source line was printed. The
24 process cases were enumerated explicitly in the mutation runner; the five
production-wiring cases were run separately. The owner-death reap mutation was
also repeated against the real grandchild proof, and boot-error classification
was repeated with the actual changed return line printed.

| Guard / source line | Mutation | RED / restored GREEN |
|---|---|---|
| Process reap, `lane-processes.py:126` | Always skip eligible targets | 1 / 0 |
| Live owner, `lane-processes.py:123` | Permit live state | 1 / 0 |
| Unknown owner, `lane-processes.py:123` | Permit unknown state | 1 / 0 |
| Claim identity, `lane-processes.py:116` | Accept every nonempty claim | 1 / 0 |
| Exited/reused pidfd, `lane-processes.py:130` | Remove readiness refusal | 1 / 0 |
| UID boundary, `lane-processes.py:111` | Remove UID refusal | 1 / 0 |
| Malformed claim, `lane-processes.py:73` | Treat malformed as unclaimed | 1 / 0 |
| Managed namespace, `lane-processes.py:88` | Remove `wf_*` restriction | 1 / 0 |
| Live store root, `lane-processes.py:91` | Remove protected-root refusal | 1 / 0 |
| Root existence, `lane-processes.py:94` | Always report root absent | 1 / 0 |
| Repository boundary, `lane-processes.py:85` | Remove prefix refusal | 1 / 0 |
| Unlinked cwd, `lane-processes.py:80` | Remove link-count refusal | 1 / 0 |
| TERM, `lane-processes.py:132` | Disable TERM | 1 / 0 |
| KILL, `lane-processes.py:149` | Disable escalation | 1 / 0 |
| Normal teardown, `lane-processes.py:167` | Remove finished-claim sweep | 1 / 0 |
| Unknown boot, `lane-processes.py:52` | Return dead on read error | 1 / 0 |
| Self exclusion, `lane-processes.py:106` | Allow the sweeper itself | 1 / 0 |
| Kernel support, `lane-processes.py:185` | Remove pidfd capability probe | 1 / 0 |
| Claim schema, `lane-processes.py:37` | Remove schema validation | 1 / 0 |
| Owner incarnation, `lane-processes.py:57` | Ignore start-time/zombie evidence | 1 / 0 |
| Boot incarnation, `lane-processes.py:53` | Ignore boot mismatch | 1 / 0 |
| Absent owner, `lane-processes.py:61` | Treat proven absence as unknown | 1 / 0 |
| Unreadable root, `lane-processes.py:95` | Treat every OS error as absence | 1 / 0 |
| Proc enumeration, `lane-processes.py:106` | Parse nonnumeric entries as PIDs | 1 / 0 |
| Herdr env, `herdr-host.ts:720` | Drop claim at socket boundary | 1 / 0 |
| Codex env, `codex-build.sh:1382` | Delete shell-policy claim injection | 1 / 0 |
| Wrapper owner, `codex-build.sh:434` | Disable ownership wrapper | 1 / 0 |
| Gateway tick, `worktree-reaper.ts:1951` | Disable process sweep invocation | 1 / 0 |
| Missing support, `codex-build.sh:901` | Remove explicit deferral | 1 / 0 |

Table paths are within `trident/`, except `herdr-host.ts`, which is
`runtime/adapters/claude-code/persistent/herdr-host.ts`.

### Verification

- `bun test trident/codex-build.test.ts`: 114 passed.
- Specific process, worktree-reaper, Herdr and spec-index files: 208 passed.
- Herdr file with an ambient claim: 42 passed.
- `bash scripts/ci/typecheck-all.sh`: 51 configurations passed.
- `bash scripts/ci/lint.sh`: passed.
- Full leak-gate attestation is unavailable: the private PII denylist was not
  supplied. A direct worktree scan additionally flags the untracked Git pointer;
  that administrative file is not part of the change. This is not recorded as a
  green leak gate. The independent source checkout scan reported zero findings
  from available rules; private-denylist and commit-range checks were unavailable
  before the local commit. The orchestrator must run the configured gate before
  merging.

The acceptance criteria and explicit scope are recorded in
`docs/spec-items/dead-lane-process-reaping.md`; its rollup was regenerated. No
product decision was changed. Shared Git metadata in the build worktree was mounted read-only, so staging
there was refused. The same changes are delivered as a commit on this branch in
an independent writable local checkout and as a bundle for the orchestrator to
import. No push, PR creation or merge is performed by this build lane.
