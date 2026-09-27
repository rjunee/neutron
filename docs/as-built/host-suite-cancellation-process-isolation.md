## 2026-09-26 — Host suite cancellation and process-test containment

Integration includes the initial cancellation consumer wiring, its normative
specification, and the subsequent outcome-reporting and isolation repairs as
one coherent change. The validation below was first measured on that complete
candidate; integrated-head checks are recorded separately below.

The host suite runner observes its dispatched run's durable state and abort
signal before launch, during execution, and before accepting a result
(`trident/host-suite.ts:119`). Its Python owner retains the existing exact-claim
and pidfd cleanup contract, rescanning for descendants created during TERM
handling (`trident/lane-processes.py:225`). An ordinary foreground exit retains
its actual status. Cleanup uncertainty is a separate observation; an interrupted
command cannot turn that uncertainty into usable suite evidence.

The owner writes a separate request-bound cleanup report. The host checks the
request token, owner PID, foreground and wrapper outcomes, signal, and cleanup
fields before accepting it (`trident/host-suite.ts:30`). Command stderr cannot
impersonate that report. Shell callers retain their primary refusal output and
the original interruption status, including inherited ignored SIGINT
(`trident/lane-processes.py:236`). Output-pipe drain after owner exit is bounded,
so a remaining descendant cannot indefinitely withhold the interrupted result
(`trident/host-suite.ts:88`).

Process tests previously limited the imported owner's census with a parent-side
mock. Fresh owner interpreters do not inherit that mock. The test-only launcher
uses bubblewrap to require a private PID namespace and proc mount before loading owner code
(`trident/process-test-isolation.py:58`). Kernel observations verify namespace
replacement using retained kernel namespace handles, the namespace init, and
proc PID consistency. Before command launch, the outer launcher verifies the
init's kernel-supplied sender credentials, parent, and namespaces, and the init
requires approval from that external parent. Invented namespace IDs supplied
to an existing PID 1 cannot authorize command launch. Kernel parent-death
bindings cover both the Bun-to-Python and Python-to-namespace-launcher edges;
parent identity is checked before and after arming each binding, including a
parent that exited before its child started (`trident/process-test-isolation.py:34`).
The whole Bun
invocation enters that boundary in its first preload, preserving the original
CLI, test names, filtering, hooks, and counts
(`tests/support/process-test-isolation-preload.ts:8`). Direct test entry points
also refuse missing isolation. Namespace unavailability fails the invocation;
there is no production test flag or host-process fallback.

Validation of the current isolation proposal: `python3 -B
trident/process-test-isolation-test.py -v` passed thirteen mock-only boundary
controls. The final `bun test trident/process-test-isolation.test.ts` passed four
tests and 22 assertions, including those thirteen Python controls. A synthetic
suite with a stubbed namespace command demonstrated refusal before module
loading and exact preservation of Bun's filter and timeout arguments. Its first
restricted-sandbox invocation refused namespace-handle inspection; the unchanged
command passed when those kernel reads were permitted. These checks did not
create a namespace or execute process-signalling subjects.

Two subsequent metadata-only bubblewrap probes completed successfully. They
established preservation of the normal UID/GID and bootstrap descriptors,
kernel namespace-handle types, the external peer's socket credentials, the
expected launcher-to-init parent relationship, and the installed inner
parent-death binding. The metadata commands exited normally and loaded no
process-owner fixture. The first lifecycle run reached 39 tests but recorded
27 device-open errors before physical fixture creation: the bound filesystem
did not provide an accessible `/dev/null`. Adding bubblewrap's private `--dev
/dev` mount resolved that environment failure without exposing host devices.
A third metadata probe confirmed the private device was usable.

The exact command `python3 -B trident/process-test-isolation.py -- python3 -B
trident/lane-processes-test.py -v` then completed with exit zero: 39 tests passed
in 6.818 seconds. This includes genuine pidfds, detached late-TERM descendants,
and live sibling preservation. The thirteen mock-only boundary controls also
passed. The launcher digest was unchanged before and after the physical run.

Six serial mutation controls ran in fresh copies behind the same reviewed
boundary. Each had one passing baseline test, the intended named semantic
failure, and one passing restored test (18 terminal phases). The mutations
disabled descendant signals, overapplied finished-claim ownership, reaped a live
owner's child, ignored cancellation while waiting, omitted the late-descendant
rescan, and accepted an unknown census as empty. The cancellation mutation
produced the expected five-second owner-wait timeout; the other five produced
their expected assertions. Namespace, import, setup, or parser failures did not
count as semantic evidence. Helper and fixture bytes were checked before and
after every invocation.

The whole-invocation Bun consumer check, `bun test trident/host-suite.test.ts
trident/lane-processes.test.ts`, passed all 27 tests and 43 assertions in 22.41
seconds. The child preload logged verified private PID and mount namespaces;
the boundary and fixture digests were unchanged across the run.
The selected Codex wrapper regressions passed nine tests and 40 assertions; the
consuming Open cancellation, missing-command, panel-refusal, and publication-retry
regressions passed eight tests and 172 assertions. Both invocations logged the
verified private namespaces and preserved the boundary and fixture digests.

CI now prepares the distribution's bubblewrap dependency and a harmless
namespace probe before shard tests. Its prerequisite regression covers absent
and already-installed executables, failed capability probes, and missing or
misordered setup. Both prerequisite controls passed (nine assertions); their
installer and capability commands were mocked, not privileged installations.

Root and Trident TypeScript checks and the canonical lint command completed
successfully. The canonical full suite and integrated CI remain required for
this proposal. Earlier full-suite receipts predate the isolation change and do
not establish those results for the current source. This record does not close
the spec item's acceptance gates.

Integrated-head validation repeated the 27-test focused lifecycle suite, the
nine selected wrapper regressions, eight consuming Open regressions, four
boundary controls, and two CI prerequisite controls successfully. Ten additional
review/publication cancellation admission and receipt cases passed. Root and
Trident typechecks both passed. The first Open and root-typecheck attempts could
not resolve the newly declared workspace test dependency; the ordinary frozen
installation materialized it without tracked-file changes, and the unchanged
checks passed. All physical consumer invocations logged their verified private
namespaces. The reviewed boundary, owner, and Python fixture bytes remained
unchanged across integration and these checks. No integrated full-suite or CI
result is claimed here.
