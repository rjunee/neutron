## 2026-09-28 — Explicit native task phase import

The command importer recognized tests and GitHub publication commands, leaving
native in-conversation build, review and fix work dependent on individually
authored phase records (`scripts/build-timeline-codex-import.ts:80`). The timeline
spec requires direct-work attribution with explicit PR ownership and recorded
boundaries (`docs/spec-items/temporary-build-timeline-dashboard.md:24`, `:102`).

Private import configuration now accepts `turnBindings` that attest an exact
session, turn, phase and PR links. The importer refuses duplicate/invalid mappings
(`scripts/build-timeline-codex-import.ts:105`). A native `task_complete` supplies
its recorded epoch-second boundaries (`:143`); a matching explicit binding is
required before the task becomes a phase (`:181`). A checkout or PR mention never
supplies that binding. Missing completion contributes no invented interval.
These are task envelopes, whose nested commands can overlap, rather than summed
action durations. Unreported token/cost metrics and missing/mixed model contexts
remain unknown. Raw task text and paths are not exported.

The regression consumes imported build/review/fix phases through the authenticated
HTML handler alongside nested command spans
(`scripts/build-timeline-codex-import.test.ts:31`). Wrong-session, wrong-turn,
unbound, incomplete and mixed-model controls cover the rejection/unknown cases.
Removing the session comparison made one regression fail; reversing the turn
comparison made four regressions fail. Both semantic mutations were restored.

Independent review caught a replay defect: tail-relative line/byte references
changed the payload of the same stable event when the source grew. Evidence now
names the opaque source and native receipt ID; scan offsets stay in coverage.
The journal-consuming regression imports two moving tails and a full scan,
verifies repeat imports append zero events, and serves exactly one task and one
nested command phase. Reintroducing the tail offset made that regression fail.
The integration retains immutable event IDs before passing new imports to the
append-only writer: losing model context in a later tail is not a new snapshot.
Partial task imports always leave the whole-task model unknown. Otherwise a
tail containing only the last model of a mixed-model task could incorrectly
enrich an unknown full-scan model. A consuming control preserves a full scan's
known model on replay and keeps a mixed-model envelope unknown through the
private refresher's enrichment rule and the authenticated dashboard.

Validation: 66 tests across the importer, recorder, sources, projection, HTML and
popover suites passed; both root and Trident TypeScript checks passed. Including
the server suite produced 71 passes and one environment failure when the sandbox
denied its loopback listener. The shared-host admission check refused because the
sandbox could not resolve the remote Git host. Neither is claimed as a passing
shared-host/live gate; integration must run those checks with the needed access.

Deployment and private source registration are separate operational steps. The
refresh service must receive each rollout/config pair. Existing explicit phase
records remain the forward start/end producer while native tasks are open. No
deployment or newly visible live phase is claimed by this record.
