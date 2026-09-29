## 2026-09-29 — Authenticate concrete-model capacity before native continuation

This is a partial integration, not release readiness or completion of #1416.
Default native aliases still lack an authenticated resolved-model binding.
The client refuses aliases rather than guessing a provider model from mutable
transcripts or metadata. The consuming positive explicitly configures a concrete
model through the existing model selector; that does not prove ordinary Fable
recovery. The normative item is `docs/spec-items/claude-same-agent-continuation.md`.

`runtime/workers/claude-capacity-client.ts` consumes the existing authenticated
local capacity protocol using independently provisioned public verification
material under protected root-owned ancestry. It verifies exact correlation,
signature, boot, freshness and canonical credential destination, and refuses
known immutable environment authentication overrides. It never reads, copies or
writes credential material. This does not attest which account the native CLI
actually consumed, nor independently attest every native settings/auth source.

`runtime/workers/claude-native-continuation.ts` requests capacity only after
validating the original request, child, launch, quota event and workspace. The
connection remains held through the bounded one-use submission. Its signed
opaque generation is saved in the durable claim. Missing/uncertain/all-full
capacity spends no claim; a later fresh affirmative observation can continue
the same child. Original-result harvesting and observation of a previously spent
claim do not require new capacity. No replacement child, substrate fallback,
lease-release rule or publication validator is introduced.

The real-socket runtime tests passed 58 cases with 156 assertions. The focused
consuming `open/__tests__/project-build-e2e.test.ts` checks passed 21 cases with
121 assertions before adding the explicit persisted-receipt assertion. Signature
allow-all mutation made the forged consuming case merge and fail its refusal
assertion; deny-all made all three consuming positives fail. Both mutations were
restored. Root and Trident TypeScript checks and targeted ESLint passed during
development. Final committed-source receipts, including the full consuming
suite, accompany the handoff; no unfinished full run is claimed here.

No live provider turn, account rotation or deployment was performed. Genuine
A-only native failure, old-account reset and post-B still-capped evidence remain
unperformed. The live proof text now follows approved Managed custody and normal
selection, without a copied isolated credential bank or manual shared-account swap.

Independent review found that re-merging current host environment could not
establish a surviving parent's auth source. The follow-up adds a fresh-only,
credential-free launch observation in `native-file-auth.ts`, retained in the
original signed launch and independently held with the measured process identity.
Known socket/descriptor/host routes and helper/env settings refuse; settings
identity changes revoke the observation. Implicit profile and legacy key sources
are refused, not resolved by guessed precedence. Adoption's executable/argv
observation cannot mint this authority, so adopted/legacy parents without it
remain UNKNOWN. The previous adopted-positive fixture is now a refusal control.

The revised runtime controls passed 73 cases with 178 assertions; consuming
controls passed 27 cases with 152 assertions. Both auth allow-all and deny-all
mutations fail the consuming inherited-socket refusal and clean fresh positive,
respectively. The earlier full consuming run was explicitly stopped after more
than 200 passing cases to fix this finding; it is not a full-suite acceptance
receipt. Preclaim failure preserves the opportunity; postclaim expiry or lost
transport remains spent and observation-only, an explicit liveness limitation.
These checks do not establish a complete installed-CLI effective-auth attestation
or resolve the default alias blocker.
