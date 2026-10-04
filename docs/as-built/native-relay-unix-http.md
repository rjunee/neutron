## 2026-10-04 — Match the native Unix relay's local HTTP transport

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

This change advances #1416's native transport acceptance, not its closure.
Live provider response, original-child quota continuation and actual project
dispatch remain separate acceptance evidence.
