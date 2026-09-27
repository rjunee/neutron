## 2026-09-26 — Resume recorded project conversations without a new chat turn

Refs #1342 and Decisions Log 2026-09-26. The previous startup policy deliberately
adopted surviving Claude panes only. `existingClaudeRepl` required a pane handle,
although dead-pane reconciliation preserves the row's session, model and reuse
identity. Startup now discovers that retained row and resumes its exact transcript
without invoking `Substrate.start` or supplying a prompt.

`runtime/adapters/claude-code/persistent/startup-recovery.ts` validates current
scope, credential fingerprint, transcript, model and tool profile; adoption still
probes the old owner first. The pre-spawn reservation checks the exact inspected
row under the registry lock (`spawn.ts`), so concurrent retirement or replacement
cannot be resurrected from an old snapshot. The native resume-picker fallback is
refused during exact startup resume. Spawned effort is now recorded and restored;
legacy rows without that field continue using the configured effort resolver.
Absent records and explicit retirement do not create new conversations. Invalid
or unreadable records produce a reasoned refusal.

`open/composer.ts` awaits recovery after graph tools bind and resumes existing
maintenance fences before starting a lost parent. Claude and Codex use their own
native recovery authority. A serialized retry loop handles terminal-host startup
delay without client traffic; shutdown drains it before closing its owner stores.
Provider and credential eligibility are re-resolved on every pass. A completed
adoption whose child subsequently exits is re-probed, while a retained pooled
owner and an in-flight adoption keep their existing synchronization.

Validation: 17 focused cases in
`runtime/adapters/claude-code/persistent/__tests__/startup-recovery.test.ts` and
`open/__tests__/project-chat-recovery.test.ts` passed. The terminal and process
boundaries are fake, with temporary localhost readiness listeners; no real
provider process, terminal daemon or service was launched or signalled. The
native-boundary cases assert exact `--resume`, retained transcript/model/effort,
one spawn across concurrent requests, repeated-start idempotency, zero submitted
turns, and refusal of a native picker. Disabling the new row comparison caused
the retirement-race control to fail by reaching the fake spawn boundary; restoring
the comparison restored the passing result. Root and Open TypeScript checks pass.

This is not a served restart/reboot receipt or a full-suite receipt. Consuming
Open boot/build tests and the served unattended workflow witness remain for the
coordinated integration gate. The recovery spec's boxes remain unchecked.
Codex's separate crash-recovery record documents its legacy same-boot and
unresolved-work limits. Conversation readiness does not clear an interrupted
workflow's durable unknown-work marker, replace admission ownership, or replay
a previously dispatched operation. Full automatic workflow continuation remains
unverified by this change.
