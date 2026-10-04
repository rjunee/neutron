## 2026-10-04 — Repair native Unix transport and terminal-turn settlement

The registered launcher supplied an HTTPS provider origin alongside the native
Unix socket. Actual official Claude CLI Messages traffic consequently began with
a TLS ClientHello, while the local relay expects plaintext HTTP/1.1. Startup
policy GETs used plaintext independently, so that partial activity did not prove
the Messages path. This caused a transport failure before provider observations;
it was not evidence of exhausted subscription quota.

The registered launcher now uses a shared fixed HTTP loopback port-zero base URL.
The Unix socket remains the only usable destination: a missing socket fails, and
ignoring the socket cannot address an external plaintext provider. Real account
credentials still belong to the host, whose upstream contract remains verified
HTTPS. Unregistered self-host authentication and configured URLs are unchanged.
The route fingerprint now includes this wire profile with a version-three tag;
the independent signed relay control protocol remains version two.

An old live parent is not made current by rewriting its registry. Existing
fingerprint and native-child guards refuse incompatible recovery. For a known
old owner, the supported transition first settles its actual turn and leases,
rearms any exact cap independently, and lets canonical scope sleep retire it
before deployment. Normal admitted wake then resumes the same native session
with a genuinely new generation and transport. Held or unknown native work is
not killed or cleared. Historical signed evidence remains byte-for-byte intact.

The offline `scripts/proof/native-unix-wire.py` consumes the production launch
environment and official interactive CLI in a private, egress-disabled network
namespace, with empty synthetic config and placeholder authentication. Both
versions 2.1.287 and 2.1.289 produced the old TLS prefix `160301` as a negative
control and the corrected plaintext `POST /v1/messages?beta=true HTTP/1.1`.
No provider request or owner history was used. This proves native wire framing,
not live provider acceptance.

Fresh native parents also install generation-authenticated HTTP
`UserPromptSubmit` and `StopFailure` hooks. Before injection the adapter arms the
exact turn; the native prompt ID must bind its root channel envelope before a
terminal API error may settle it. The existing failed event path releases normal
conversation admission while retaining unresolved native-child leases. Exact,
idempotent terminal acknowledgement retires only that turn's reply scalar before
warm reuse; older stale-reply debt remains intact. Existing children without the
hooks cannot retroactively settle from a rendered error.

No-egress official CLI probes on 2.1.287 and 2.1.289 measured native
`StopFailure` with `server_error` and `ECONNRESET` after 11 and 22 synthetic local
POSTs respectively. The 2.1.287 trace also correlates the actual injected channel
envelope and native prompt ID with that terminal failure. On 2.1.289, a separate
synthetic HTTP 400 trace proves channel-envelope/terminal-prompt correlation;
the reset trace uses a direct prompt. Native HTTP hook payload and authenticated
header delivery was additionally measured on both versions; the 2.1.287 HTTP
delivery fixture used a synthetic HTTP 400 and retained its live CLI. None used
a provider account.
The terminal-failure consuming and endpoint controls passed 18 tests with 108
assertions. Disabling settlement failed its accepting control; bypassing terminal
event/prompt correlation failed six refusal cases; removing the real dev-channel
acknowledgement route failed its endpoint control. All three mutations were
restored. These fixture results do not establish live provider acceptance.
The terminal-failure author's full five-file consuming run, including the entire
existing `open/__tests__/project-build-e2e.test.ts`, passed 619 tests with 7,888
assertions. That receipt precedes combination with the transport and cap guard;
it is not substituted for the combined full-host gate.

The owner-authenticated forced-respawn route also bypassed the independent
signed cap-release requirement: its force branch deleted `capped_at` before
replacement. Shared supervision now refuses a capped row without a registry
write, kill or spawn. Signed exact-episode rearm remains the sole cap-release
operation; uncapped forced same-session recovery retains its scope, child-liveness
and in-flight guards. Forced restart retains process-death/replay semantics and
is not turn cancellation.

The consuming HTTP fixture uses the real root-only Ed25519 issuer, pinned
verifier, registry rearm and supervision path. Bearer-only, foreign,
stale-generation, missing-authority and non-root cases cannot release the cap;
valid signed rearm enables same-session/new-generation recovery. Restored guard,
scope and signed-rearm tests passed 45 cases with 266 assertions. Restoring force
cap deletion failed the refusal control (202 instead of 500); refusing every
force failed the signed-rearm success control (500 instead of 202). Both
mutations were restored.

Focused transport, fingerprint, actual spawn and startup tests passed 46 cases
with 328 assertions. The consuming
`open/__tests__/project-build-e2e.test.ts` Unix-transport case passed the complete
dispatch-to-merge harness with 25 assertions; only its model boundary is
synthetic. Canonical old-protocol sleep/new-protocol wake passed 18 assertions,
including unchanged session ID, retained old fingerprint while asleep, skipped
startup wake and actual new-generation launch environment. Removing the local
HTTP correction broke the consuming build; applying it to an unregistered
self-host broke that refusal control; retaining the old fingerprint admitted
the incompatible row and broke its recovery refusal. All mutations were restored.

Final scoped verification passed 28 registered-route, Unix and protocol cases
across the six affected test files (214 assertions), including the consuming
build and sleep/wake cases. Both exact root and Trident TypeScript checks and
the full CI lint script passed. An earlier unfiltered exploratory run was
interrupted with exit 143 after test-only typing errors were found; its partial
output is not full-suite evidence.
After integrating all three source changes, both exact root and Trident
TypeScript checks and the full CI lint script passed again.

This change advances #1416's native transport acceptance, not its closure.
Live provider response, original-child quota continuation and actual project
dispatch remain separate acceptance evidence.
