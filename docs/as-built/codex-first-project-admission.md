## 2026-09-28 — Admit the first Codex project without a gateway restart

The shared chat dispatcher used a boot-time inventory of Codex projects to
decide whether it existed. Its absence also omitted the project launcher and
chat handler for the lifetime of the composition. A project selected later
could obtain a pinned native substrate but could not reach the shared intake.

The native owner binding now keeps that dispatcher available independently of
the initial project inventory (`open/wiring/substrates.ts:244`). The composition
wires the binding at `open/composer.ts:1254`; its existing launcher and chat
construction consume the available dispatcher at `open/composer.ts:1295` and
`open/composer.ts:5994`. Provider resolution and credential validation still
occur on each dispatch. Credentialless Claude requests produce the existing
`no_credentials` refusal, and helper substrates remain unavailable.

Verification: 66 focused tests passed across
`open/__tests__/open-wiring-substrates.test.ts` and
`open/__tests__/open-trident-prod-boot-wiring.test.ts`. The production composition
test creates its first Codex project after boot, sends through the HTTP chat
surface, and requires a durable agent reply (`open/__tests__/open-trident-prod-boot-wiring.test.ts:1657`).
The native model turn is a fixture. The wiring test exercises live selection,
switching away, missing credentials and a refused native binding
(`open/__tests__/open-wiring-substrates.test.ts:1157`). Restoring the boot-only
gate fails the production check; allowing every pinned provider fails the
credentialless factory check. Both mutations were reverted.

This is an offline admission repair for #978, not its live owner/build/restart
acceptance. That issue remains open for the served continuity witness.
