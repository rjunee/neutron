## 2026-10-10 — Prepare and consume exact native-review parent termination

Expired reviews can leave original child leases held after their workflow has
failed. An application restart preserves that ownership correctly, but cannot
produce evidence that the original native execution ended. The authenticated
parent recovery contract in SPEC's 2026-10-10 decision adds a targeted operator
operation for signed, expired reviews of terminal runs.

`runtime/workers/native-parent-termination.ts` verifies independently signed
preparation and completion against the configured operator pin and original
child-bound dispatch signatures. `open/wiring/native-parent-termination.ts`
joins those proofs to canonical runs, attempts, receipts, complete project leases,
current kernel boot and native-parent census. Both standalone `project-review`
and panel `verdict` requests are eligible; output format supplies no termination
authority. The owner-authenticated prepare
and consume routes are mounted in `open/composer.ts`.

`gateway/project-admission-store.ts` prepares one maintenance hold and permanent
work/conversation fences atomically. Completion requires the exact prepared
lease multiset and independently observed termination of the complete attributed
execution tree; all child
leases and the maintenance hold are consumed together. Existing retirement
tables supply these mechanics without a schema migration. Failed workflow and
attempt history, original receipts and deadlines remain unchanged.

The persistent adapter can quarantine the complete positively bound background
request set while rejecting ordinary turns and foreign or unknown slots. It
detaches without sending input or signals. A verified completed termination
allows the existing terminal metadata handoff after the original process is
gone. The real workspace manager requires the original pane birth receipt and
an empty foreground before releasing only its Chat claim. A fresh placement
retains the quarantined pane and registry history; prepared quarantine alone
cannot release that terminal slot. The existing
living-parent planner protocol and different-boot whole-host protocol retain
their previous requirements.

Focused verification passed 139 tests with 912 assertions across the admission
store, consuming boundary, HTTP surface and persistent quarantine/handoff paths.
Controls cover altered signatures, original receipt/lease mismatches, incomplete
ownership, unexpired deadlines, live runs, live parents, incomplete execution-tree termination, interrupted writes and
other-project preservation. Four mutations removing operator authentication, the live-parent refusal or
complete-lease checks, or restoring the old live-process workspace requirement,
each failed the opposing tests. The workspace test uses a real isolated child
process and the actual lifecycle and workspace manager; foreign foreground
processes and changed pane birth receipts both prevent handoff.
An ephemeral real turn through `createClaudeCodeSubstrateAuto`, the retained Bun
PTY backend and registered native relay completed in approximately four seconds.
Read-only checks also matched the three actual retained dispatch receipts and
canonical terminal-run/attempt records, including their mixed result formats.
These checks do not establish deployment or fresh unattended sequence acceptance;
the independent operator must still supply an actual retained-process exit proof.
