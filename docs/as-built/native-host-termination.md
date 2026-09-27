## 2026-09-27 — Prepared native-child termination across a physical host reboot

Legacy unsigned native dispatches cannot retrospectively acquire an original
pre-input refusal receipt. A terminal workflow and a missing parent process also
cannot prove that escaped native descendants are dead. The restart spec now
defines a separate, independently authenticated physical-host recovery protocol.

`runtime/workers/native-host-termination.ts` defines pinned Ed25519 preparation
and fresh challenged boot evidence. `open/wiring/native-host-termination.ts`
accepts preparation only on the original measured kernel, for the exact durable
native-child lease and a canonical terminal native-dispatch attempt. Migration
0161 and `gateway/project-admission-store.ts` persist a separate admission gate.
The consumer records `terminated-by-host-reboot` and removes only the unchanged
full lease in one transaction after a different authenticated kernel boot.
Run, attempt, result, armed request and publication provenance remain untouched.
Other unresolved work remains held; no workflow is redispatched.
Ordinary token/work completion cannot delete a pending preparation's reserved
lease; only authenticated recovery consumes that token. A changed trust pin
refuses, while restoration of the original authority remains recoverable.

`open/composer.ts` awaits consumption before native actor construction and
workflow/chat replay. The actual `open/server.ts` entrypoint loads its pin from
the fixed effective-UID operator configuration, checking root ownership,
non-writable ancestry, and symlink refusal. Its Unix client requests only a
challenged boot observation. Missing authority cannot consume prepared records;
present malformed configuration refuses startup. The independently deployed
supervisor owns peer authorization, signing, historical-placement verification
and hardware-bound host identity; application boot UUIDs and cloned machine-id
values are not substitutes.

`open/prepare-native-host-termination.ts` is the executable operator bridge: it
reads a bounded signed preparation from stdin, resolves the server's ordinary
install configuration under its effective UID, and reports only prepared/refused.
It does not create or migrate a database. Exercising that path exposed Bun's
requirement for an explicit writable-open bit when creation is disabled;
`persistence/db.ts` now sets `readwrite: !readonly`. Existing-only writing,
missing-file refusal and read-only write refusal have regression coverage.

Verification: 155 focused tests passed, covering recovery, protected configuration,
real server-entrypoint wiring, admission, native dispatch, migration snapshot and
table-ownership conformance, plus operator preparation and persistence. Both root
and Trident TypeScript checks passed.
Semantic mutations that removed the same-kernel refusal and forced permanent
refusal each failed the corresponding test assertion; restored code passed.
Removing either ordinary-release exclusion independently failed its positive
prepared-token retention assertion. Removing writable existing-only support or
allowing file creation also independently failed the persistence regression.
The earlier recovery candidate passed all 356 consuming tests in
`open/__tests__/project-build-e2e.test.ts` inside the authenticated private PID/proc
test boundary, before the final operator-bridge and release-exclusion additions.
Those final additions were checked with the focused affected tests; the combined
integration gate is separate. The workspace dependency verifier passed. These are offline implementation
checks, not evidence of a live host reboot or deployment restoration. Live
preparation, signing-key provisioning, physical restart and dispatch acceptance
remain separate operator-controlled deployment work.

The first combined host gate executed all 1,725 declared test files and refused
publication on two failing lanes. Three explicit migration-ledger expectations
omitted migration 161; adding that ordinal preserved their exact-order, drift
and skip assertions, and all 27 affected tests passed. The reaper startup timer
fixture also invoked the real process-signalling sweep while polling a deadline.
It now holds a local command stub until stop drainage, asserting immediate
startup, the exact Python command, default cadence and timer clearing without
signalling host processes. Its focused test passed; independent mutations that
disabled immediate startup or changed the default cadence failed their semantic
assertions. These necessary fixture repairs do not substitute for the final
combined gate on the frozen repaired candidate.
