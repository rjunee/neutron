## 2026-09-19 — Restore authorized live-chat REPLs during graph boot

The live-chat wrapper previously materialized its Claude adapter only when a
turn drained. A gateway restart therefore left a durable project survivor
without sink authorization until another app turn constructed its adapter.

Open now supplies an awaited graph-ready callback, after the graph installs its
tool bridge and Cores surfaces (`open/composer.ts:6829`,
`gateway/composition.ts:367`). It enumerates General and non-deleted projects,
applies the same configured-model/provider precedence as dispatch, and derives
exact candidate keys from current credential identities. Discovery reads no
secrets and never parses opaque registry keys. Unknown registry evidence is
reported explicitly. Only a matching durable pane row reaches exact-credential
auth resolution and the shared option builder
(`gateway/wiring/build-llm-call-substrate.ts:890`,
`runtime/adapters/claude-code/index.ts:420`).

The runtime reuses the existing adoption claims and fencing protocol without
starting a turn. Only an adopted survivor is registered for supervision; dead
or absent candidates cannot become watchdog cold-spawn requests. A concurrent
real turn's options take precedence over boot registration. Other substrate
families retain lazy reconciliation. The spec item keeps this scope explicit;
the new Decisions Log entry supersedes the earlier live-chat deferral while
preserving the immutable earlier entries.

Stable credential IDs do not prove the secret is unchanged. Proactive adoption
therefore checks the final auth environment's fingerprint against the actual
durable row before host effects, then rechecks it in the claim's critical
section (`runtime/adapters/claude-code/persistent/boot-adoption.ts:815`,
`:1970`). Missing/stale evidence returns an uncached refusal without claiming,
closing or spawning; explicit empty ambient fingerprints remain valid. Cached
passes carry their fingerprint policy: a proactive caller awaiting an earlier
unguarded or differently guarded pass receives its own refusal, preserving the
original caller's pass and authority (`boot-adoption.ts:452`).

Shared option composition preserves normal dispatch ordering: project identity
is resolved after asynchronous environment resolution, and OpenAI continuation
invalidation occurs before the remaining option getters. A held-environment
regression fails when project resolution is moved early (expected `after-env`,
received `before-env`); restoring the original ordering passes.

The first published head's CodeQL check failed on the pre-existing
unkeyed, truncated auth fingerprint, already alerted on the base branch.
The replacement is a versioned, full-width scrypt derivation with explicit
memory-hard parameters and a domain-prefixed, persisted per-instance salt.
Spawn, warm reuse and boot adoption compute the same format from the same
resolved instance path; the empty ambient-auth sentinel is unchanged and
performs no salt I/O. This is a rotation-equality value for opaque provider
tokens, not a human-password verifier. This pre-cutover format replacement
does not include a legacy verifier: computing the new value from today's token
alone cannot justify relabeling old child evidence after a same-ID rotation.
Nonempty legacy rows are therefore refused without claiming or closing the
child. There is no silent compatibility path or automatic relabeling. The only
pane-bearing agent survivor measured on this pre-cutover instance uses the
empty ambient sentinel, so that particular row requires no format migration.
Deployment and a fresh live run are still required to prove it is adopted and
can dispatch.

The replacement's focused tests passed 185 cases. Independent reruns passed
164 cases across fingerprint, boot adoption, credential rotation, live Open
composition and the consuming `open/__tests__/project-build-e2e.test.ts` suite
(68 cases). Both root and Trident typechecks, lint and dependency layering
passed. In an isolated copy, bypassing final credential parity admitted stale
panes, over-applying it rejected the valid survivor, and fixing the salt made
different instances' tags equal; each mutation made its intended test red,
then restored controls passed. Independent security and bounded cross-model
reviews found no code blocker. Final-head CI and deployment remain separate
gates.

Verification includes the production-graph survivor regression, existing
adoption/fencing suites, provider/profile regressions, composition field guards,
and `open/__tests__/project-build-e2e.test.ts`. The project-build and composition
coverage run passed 73 tests; adoption suites passed 93; wrapper,
provider and characterization checks passed 90. The complete 51-config typecheck
matrix passed, followed by fresh gateway/open/runtime checks after the final
ordering changes. The final survivor suite passed four tests with 81 assertions:
two project survivors perform real scoped tool calls before any app turn; two
credential IDs retain separate sessions; excluded identities and stale secrets
never gain authority; unmatched credential secrets are unread; and a held first
turn joins the survivor without overwriting its own options. Claim-policy and
fingerprint races passed four focused tests with 31 assertions. Removing the
claim's fingerprint check made its race test fail (adopted instead of refused),
then restoring it passed. Dependency checks reported no new violations.

The full local leak scan exited 1 on 465 tree findings, predominantly existing
denylist matches. Scoped added-lines/new-files and proposed publication metadata
scans were silent; the changed-file copy's three denylist matches were verified
against unchanged base lines. This record does not claim a clean local full-tree
purity scan; publication requires the canonical final-head CI gates.
