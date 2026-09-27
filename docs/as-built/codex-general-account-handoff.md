## 2026-09-27 — Guarded General Codex account handoff with native acknowledgement

The existing workspace item requires a verified credential handoff, but the
native owner's resume guards deliberately require the predecessor's credential
home and transcript namespace. Loosening those checks on the assumption that
`thread/resume.path` permits arbitrary cross-home resume would not implement the
feature. The new disposable native smoke exercises the installed CLI against a
loopback fixture provider with no credential file in either home.

With Codex CLI 0.157.0, a fresh process in the original home resumes its thread.
A process in the second home refuses both the original thread id alone and an
explicit path into the original home with `no rollout found`. After the first
process has exited, transferring only the transcript into the second home's
session namespace permits resume. The native result preserves the original
thread and session ids, and the subsequent local provider request includes the
original conversation. The new file retains the old transcript prefix. Neither
home contains `auth.json`.

The fixture deliberately supplies an unrelated thread id with the valid staged
path: the CLI returns the transcript's original id. This is a positive control
for why a successful resume response alone cannot authorize a handoff. The
workspace item now requires explicit predecessor/target authority, complete idle
retirement, reserved transcript transfer and independent returned-identity checks.

The consuming implementation handles a changed selected global seat at General
admission. It resolves the retained account through its configured global grant,
holds host admission, verifies target ownership is vacant, and makes an on-demand
native metadata preflight in the target's canonical home. The preflight accepts
only the expected backend account id and explicit `ordinaryUsageAllowed: true`;
percentages, reset credits and missing windows cannot substitute. Its process
must exit before retirement proceeds. No thread or model turn is generated.

The existing complete native retirement lease still owns the idle decision and
exact process exit. Before requesting retirement, the fixed General authority
acquires an exclusive immutable preparation naming the exact old binding and
target. A corroborated clean-busy refusal records an immutable abort; unknown
outcomes retain preparation. Completed process-death evidence advances that same
prepared target to its append-only transcript transition record. Only transcript
bytes enter a new,
generation-specific path in the target home's session namespace. Source digest,
predecessor lineage, project scope and private canonical paths are checked.
Partial or foreign destinations are refused, not overwritten. Ordinary same-home
resume retains its original guard; cross-home resume needs this explicit receipt.

The successor repeats the identity-bound native quota read before resuming. It
injects only the reserved path, independently reads back the thread, and attests
the original thread/session/history together with the target account. An immutable
acknowledgement corroborated by the host's native authority publishes the new
General generation. Lost acknowledgement can be completed by attachment to that
same successor. Ambiguous launch or interrupted transcript staging stays fenced;
the transition record is not deleted to retry another account. Returning to a
previously used account stages a fresh transcript instead of rewriting old history.

Independent review identified and corrected the boundary between completed
retirement and durable reservation. Injecting a gateway loss immediately after
the helper writes its retirement receipt now leaves preparation intact. The real
durable opener refuses ordinary old-account resume; fresh bindings corroborate
the receipt and open only the reserved target. A missing receipt launches neither
account. This uncertainty uses the handoff record, not a fabricated model-work
marker in an account to which no new prompt was sent.
Repair mutations also reject an omitted preparation write, bypassed durable-opener
barrier (caught by an actual old-account launch attempt at the spied host port),
and an implementation that refuses every otherwise eligible completed handoff.

Cross-model review then identified two independently reproduced integration
edges. Configured path aliases were compared to the canonical General authority
before normalization; both credential lookup and consuming admission now compare
the same canonical home and directory while retaining account/grant checks.
The real helper could write its retiring marker before the broker's second idle
census returned busy. The repeated durable-settlement finding was arbitrated
before repair. The broker now invokes the existing synchronous marker callback
after that final idle census and immediately before journal/process close.
Callback failure returns unknown with the lease retained and no native close;
neither helper marker semantics nor the explicit abort guard is weakened.

An actual helper/bootstrap/broker fixture composes both native censuses with the
General preparation/abort ledger. Late activity leaves no marker and no native
close, earns an explicit abort, then permits a successful retirement retry.
Positive retirement observes the marker before process close; a conflicting
marker produces unknown without overwriting it, closing native, or releasing
General preparation. Mutations moving the marker early, omitting it entirely,
closing on callback failure, and comparing a raw configured alias were all
rejected. A separate positive sealed-crash control verifies missing predecessor
authority already refuses recovery; that guard was not relaxed in response to
an unsubstantiated review premise.

This implements General's handoff of an already selected global seat, not a new
quota-threshold selector, periodic probing loop, project grant policy, or Claude
retirement authority. Project conversations still need their explicit project
credential grant. No live account switch, refresh operation, provider quota probe,
or production deployment was performed while developing this change.

Validation includes the credential-free native smoke (Codex CLI 0.157.0), now
using the exact generation-specific destination and the native TUI's pre-resume
`thread/read`; consuming General admission, reservation/restart, account/protocol
refusals, transcript integrity and actual bootstrap tests; and the existing owner
retirement/regression tests. The local listener suites require host permission;
the initial sandbox run's Unix-listener failures were environmental, and the
authorized rerun passed. Four mutations were killed: accepting a foreign account,
rejecting every valid handoff, retiring despite a held General lease, and
publishing without native acknowledgement. The held-lease mutation is caught by
its forbidden probe/retire/launch side effects, not merely an error string.

Authenticated production handoff and the repository-wide CI gate are separate
from this native fixture and scoped test evidence; neither is claimed here.
