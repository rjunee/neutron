## 2026-09-26 — Herdr protocol refusals preserve credential health

`verifyHerdrProtocol` rejected an unsupported protocol or incomplete ping metadata
with an untyped error. The persistent turn driver treated that error as retryable,
and the gateway could infer a rate limit and cool an otherwise healthy credential.
This violated `docs/INVARIANTS.md` invariant 39: substrate-local failures must not
be reported as credential faults.

Both refusal sites in
`runtime/adapters/claude-code/persistent/herdr-client.ts` now throw the existing
`SpawnConfigurationError`. The producer's validated type reaches the existing
turn driver and gateway classification unchanged: a nonretryable configuration
error with no credential failure or cooldown. Protocol admission and its error
messages are unchanged.

`gateway/wiring/__tests__/herdr-protocol-credential-cooldown.test.ts` drives the
real Herdr host's refusal through the persistent turn driver and gateway
credential accounting. Six attempts retain the configuration error and never
cool the credential. Supported protocol admission and genuine provider rate-limit
cooldown are positive controls. Removing the two producer stamps fails both
refusal cases; rejecting every protocol fails the supported-protocol control.
Both mutations were restored.

Validation on the isolated change based on `1c28baa69`:

- The new consuming regression, existing LLM-call substrate suite, Herdr protocol
  gate, protocol compatibility, and spawn-classification suites: 122 passed.
- `bunx tsc --noEmit -p tsconfig.json`: passed.
- `bunx tsc --noEmit -p trident/tsconfig.json`: passed.

The complete shared-host gate, exact-head CI, deployment, and live turn verification
remain publication and operational checks; the focused results above do not claim
those outcomes.
