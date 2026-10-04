## 2026-10-04 — Reconcile authenticated dead Chat ownership before ordinary reprofile

A consumed host-reboot proof could release an exact native-child hold while a
bare shell still occupied the historical Chat slot. Proactive adoption correctly
refused its changed credential fingerprint, and normal placement correctly
refused to overwrite the occupied slot. Neither result licensed deleting the
registry record, changing its grants, or killing the remaining shell.

The installed-owner reconciliation surface now verifies the original signed
evidence digest's exact byte preimage, the historical registry artifact, the
consumed different-boot observation and a fresh current-boot challenge. The
composition helper fences admission while the runtime compares the exact parent
and workspace journal, verifies no current transcript owner and relinquishes only
the dead Chat ownership. The old shell remains in a historical tab. Interrupted
cross-journal completion stays placement-blocked and can retry only with the
same authenticated identity. No fingerprint or grant is written by reconciliation.

An ordinary authorized turn resumes the native session and records its actual
new-generation launch profile. The cap remains until the existing independently
signed exact-generation cap-rearm operation clears it. Proactive fingerprint
guards, original workflow provenance and unrelated child holds remain intact.
This addresses the dead-record edge of #1237 and #1342; it does not close their
broader acceptance or claim live deployment success.

Local evidence: 33 focused tests passed with 137 assertions, including signed
same-boot refusal, remapping both registry and journal to a valid foreign shell,
between-probe registry/journal/authority races, and interrupted journal rename
after a committed registry write. The consuming
`open/__tests__/project-build-e2e.test.ts` case passed through signed historical
proof, real SQL admission refusal/release, actual same-session spawn with the
current full tool/planner profile, signed new-generation cap rearm, and the real
plan/build/review/publish/merge harness. Its model/PTY boundary and host authority
are synthetic; it exercises unregistered self-host credentials, not a live
registered relay. Existing registered-parent preparation tests independently
cover the route/profile refusal boundary.

Open and runtime TypeScript checks passed. Three temporary semantic mutations
failed as required: removing the different-boot check accepted signed same-boot
evidence; removing historical pane equality accepted a valid remapped shell;
refusing every reconciliation broke the consuming successful build case. All
mutations were restored before final validation. Full repository gate and live
operator/deployment acceptance are separate evidence, not established by these
focused checks.
