## 2026-09-23 — Explicit project chat providers and Codex owner credentials

Web and phone project settings now expose Follow instance, Claude Code and Codex,
using one shared HTTP client and the existing project settings PATCH. A provider
choice remains writable before credentials exist. Both surfaces show the effective
harness and selection source, explain configured API route precedence, and retain
the saved choice when a write fails. The phone can connect a subscription directly
to its current project; the web uses its existing project connection form.

Native Codex owner resolution previously called the reviewer resolver, which can
return a global rotating seat. The native owner then refused that home because it
lacked this project's ownership marker. The composer now requests an explicit
project grant, with no global lookup or decryption. Resolution checks the full
ownership marker and subscription account identity before materializing or harvesting
the credential. Same-account token refresh retains identity. Expiry of an access
token remains refreshable by the CLI; expiry of the stored grant is a refusal.
A harvested native refresh preserves the grant's expiry and label; a finite grant
still refuses admission after its original deadline. A current revocation probe belongs to its access-token fingerprint, so a result
for an older token cannot refuse a freshly reconnected project credential.

Cached chat, native controls and build admissions recheck the project grant and
stable account identity. Revocation or replacement refuses new admission without
creating another native owner. The added `owner_credential` status reports only local
configuration. Exact-turn interruption and declining pending approval remain available
after removal of the credential grant, so refusal cannot strand existing work.
The status carries its observation time and an explanation; an inconclusive read returns
`configured: null`. It neither reports a successful model call nor changes reviewer
inheritance or rotation.

Verification covers the credential service and HTTP surface, composed boot routing,
cached owner admission, project provider persistence, and rendered phone/web settings.
Controls distinguish global from project credentials, one project from another,
same-account refresh from account replacement, failed saves from persistence, and
unknown inspection from a missing grant. Project-keyed component mounts and sequenced
responses prevent old requests from replacing another project's provider state.
Both the owner-status display and adjacent credential panel are project-scoped:
pending reads hide the previous project's status and removal control, and failed
reads report unknown rather than disconnected.

Local verification passed 267 consuming build integration tests, 176 credential,
rotation and probe tests, 74 native-owner tests plus the focused grant-removal
approval/decline test, 15 shared-client/web tests, and the rendered phone route test.
All 51 TypeScript projects, the layering gate and changed-file lint passed. Two temporary
mutations (restoring global fallback and removing cached account comparison) made
their negative controls fail; both guards were restored and the controls passed.
Review regressions additionally went red when restoring cross-project credential
display and clearing expiry during refresh; both fixes passed after restoration.
The pre-rebase partitioned suite executed all 1,654 discovered files, with 25,105
passing tests and two failing identity-registry assertions. The broad project-ID
validation regex conservatively matches the registry's identity-name candidates;
an explanatory registry entry fixes membership without weakening its detector.
All 21 registry tests passed after the correction. After a clean rebase, 151
credential/owner/HTTP tests, 15 shared-client/web tests, the phone test, 267 consuming
build tests, all 51 TypeScript projects and the layering gate passed again.
This is not a claim of a green whole-suite local rerun on the final head; CI must
provide that witness. The local purity gate still reported 456 findings across
the tree and linked-worktree metadata, so local purity is not claimed green.

This change does not provision an account, inspect live secrets, deploy, or satisfy
#978. Served owner-to-build-to-restart acceptance and the positive installed-MCP
capability observation remain required. The existing remote-liveness probe cache
retains its bounded lifetime; local configuration is not durable proof that a
subscription remains accepted remotely. Provider changes preserve separate native
conversations and do not transfer their context between harnesses.
