## 2026-09-28 — Admit the first Codex project without a gateway restart

The shared chat dispatcher used a boot-time inventory of Codex projects to
decide whether it existed. Its absence also omitted the project launcher and
chat handler for the lifetime of the composition. The browser credential gate
also used that snapshot. A project selected later could obtain a pinned native
substrate but could not reach the shared intake.

The native owner binding now keeps that dispatcher available independently of
the initial project inventory (`open/wiring/substrates.ts:248`). The composition
wires the binding and live project predicate at `open/composer.ts:1254`; its
existing launcher and chat construction consume the available dispatcher at
`open/composer.ts:1299` and `open/composer.ts:5998`. The browser credential gate
reads that predicate per request (`open/wiring/landing.ts:132`). Provider
resolution and credential validation still occur on each dispatch. App chat
checks current availability before calling the shared intake, preserving the
actionable credentialless refusal (`open/wiring/app-ws.ts:968`). Bounded
helpers and the legacy review panel use their own factory's credential-pool
availability, independently of native owner admission (`open/composer.ts:6569`).

Verification: 116 focused tests passed across substrate, production boot,
landing, app-ws, skill-forge, arbiter, leak-fixer and durable-chatlog wiring.
The original credentialless helper-absence and actionable chat-refusal
assertions remain. The production composition
test creates its first Codex project after boot, sends through the HTTP chat
surface, and requires a durable agent reply (`open/__tests__/open-trident-prod-boot-wiring.test.ts:1657`).
The native model turn is a fixture. The wiring test exercises live selection,
switching away, missing credentials and a refused native binding
(`open/__tests__/open-wiring-substrates.test.ts:1157`). Restoring the boot-only
gate fails the production check; allowing every pinned provider fails the
credentialless factory check. Making the browser project predicate always false
or always true also fails its transition check. Additional mutations that
always expose or always omit bounded helpers, bypass chat availability or
always refuse chat each fail their consuming check. All mutations were reverted.

This is an offline admission repair for #978, not its live owner/build/restart
acceptance. That issue remains open for the served continuity witness.
