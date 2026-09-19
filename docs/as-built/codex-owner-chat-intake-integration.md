## 2026-09-19 — Draft native-only owner intake and shared build-result fence

This follow-up consumes the frozen native multi-agent capability and acting
bridge lifecycle changes. It extends the shared-owner draft; it is not cutover
or restart acceptance and does not change the frozen runtime implementations.

The composed app chat entry point depended on the generic live substrate being
non-null. A project-only Codex selection with no Claude/API credentials could
therefore be denied before provider dispatch. `open/composer.ts:1094` now threads
the stored native-project inventory into the conversational availability check
at `open/wiring/substrates.ts:262`. The legacy credential-setup gate at
`open/wiring/landing.ts:132` also permits that inventory. This does not bypass
app identity authentication or provide native credentials: the shared owner
still validates the selected project's credential home. Credential-less Claude
without a native selection remains unavailable. Inventory is composed at boot;
adding the first native project afterwards requires recomposition.

`open/wiring/codex-owner-binding.ts:139` wraps the final host-decoded in-REPL
worker result, and `open/wiring/project-build.ts:355` installs that wrapper.
An unreadable or schema-invalid child result now fences subsequent chat as well
as build, including a valid envelope whose domain payload fails validation.
Chat also refuses while child observation or host decoding remains pending
(`open/wiring/codex-owner-binding.ts:164`). Completed valid results release this
guard. Factory feature evidence is checked using the exact
`native-thread-feature-report` contract, not a requested configuration flag.

Evidence includes the real composed web WebSocket and app HTTP/chat-log routes
with no Claude/API pool, selected-project native dispatch, and an honest
Claude-null control (`open/__tests__/open-app-ws-durable-chatlog.test.ts:184`).
Only the native model turn is stubbed in that intake test. Real project runners
and the rollout observer cover valid/invalid domain payloads, malformed/missing
trailers, distinct-step refusal and pending-child chat exclusion in
`open/__tests__/codex-owner-binding.test.ts:149`. The shared-owner native smoke
also passed with the integrated factory: five actual provider turns,
chat/chat/build/chat continuity, isolated second-project thread and one factory
launch per project. Its loopback model advertises native `spawn_agent` but uses
a fixture child trailer; actual child execution is separate factory evidence.

The final shared-owner consumer suite passed 12 tests; scoped build wiring
passed 32, substrate/landing selection passed 50, composed native-only intake
passed both controls, and project-build E2E passed all 88 tests. Root and Open
TypeScript checks and changed-file lint passed.

Semantic mutations disabling the final decoder fence, rejecting every decoded
result, and removing the native inventory from composition each fail the
corresponding consuming regression. Restored controls pass. These checks run
separately from the live build's broad suite. No broad full-suite rerun is part
of this follow-up.

The full-tree privacy gate remains red as recorded in the preceding shared-owner
draft; only this change's additions and commit metadata are independently
privacy-checked. There is no new privacy exception or gate weakening.

Remaining cutover blockers are unchanged: a durable same-owner restart and
pending-child reconciliation contract, native approval response surface,
model current/list/switch, and native tool/prompt-policy integration. This
composition still uses the fresh-only local factory and supplies no helper
attachment or replay fallback. A future remote helper also needs an awaited
terminal-state reconciliation seam: a cached synchronous broker state must not
be mistaken for an exact native completion observation. No spec acceptance box
is closed by this draft.
