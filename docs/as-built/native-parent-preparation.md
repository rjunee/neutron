## 2026-10-03 — Refuse stale registered native parents before child admission

The native build bridge could select an existing project parent directly, without
the ordinary warm-session route and grant checks. A parent launched before host
relay provisioning could therefore start a bounded child whose original receipt
had no continuation launch authority. A later provider quota failure correctly
refused continuation but retained that child's unresolved ownership.

`open/wiring/project-build.ts:122` now checks the independently configured relay
route against the ready parent's authentication fingerprint, tool grants,
required planner role, measured executable and launch identity, argv and relay
scope. The read-only preflight at `open/wiring/project-build.ts:623` refuses known
stale parents before child admission. Cold acquisition remains behind admission;
the same check runs before original parent binding. A post-admission refusal
uses the existing positively-unsubmitted release path. No parent refresh,
retirement, metadata promotion or retrospective continuation authority is added.

The unregistered self-host authentication alternative remains intact. Existing
result harvesting and continuation still use their original validators and
signed authority. This prevention does not resolve a previously submitted child.
The governing work remains `claude-same-agent-continuation`, issue #1416; live
provider acceptance remains separately unproven.

Fourteen consuming cases in `open/__tests__/project-build-e2e.test.ts:1511`
cover registered warm and cold success through merge, stale authentication,
tools, planner, absent or mismatched launch, session, generation, argv, relay,
unavailable route, a post-admission identity change, and a fenced cold project.
Stale ready parents make zero admission calls and send no native input; the
post-admission refusal leaves no child lease. Both semantic mutations were
observed failing: bypassing preparation wrongly merged the stale-auth case;
refusing every registered parent blocked the accepting ready-parent case.
The production guard was restored before final verification.

The complete `bun test open/__tests__/project-build-e2e.test.ts` run passed:
576 tests, zero failures, 7,694 assertions, exit zero. This includes original
late-result recovery and the existing continuation, publication and merge gates.

The consuming fixture explicitly selects unregistered host deployment by default,
with registered cases overriding that choice. This prevents a developer machine's
protected live relay configuration from selecting a transport for fake parents.
The fourteen controls plus the existing closed-planner success case pass together.
Root, Open and Trident typechecks pass; the root check was repeated after the
fixture isolation change.

Independent source review and a genuine Opus review both returned GO on the
final production and consuming-test bytes, with no blocking findings. Follow-up
inspection confirmed that the absent-launch fixture copies its own callable
`hasChildExited` property; a bounded Bun control verified that nested route spies
restore the exact original exported function after both cleanups.

Validation candidate: base `554a2c715f2fd8f89031d0ab806c1bcf1e48a549`
with this change's working diff. Reviewed production SHA-256:
`0d6f7341e227e2fbe653a10071a532621e51444c4721ba95031c878ade580b5e`;
consuming-test SHA-256:
`fe3f30aac9f98e8ff6e617c7755d1f1578f349c3cbb9015dc9312709127fa79e`.
The canonical local check is `bash scripts/check-shared-host.sh`, which runs
all project typechecks and the complete partitioned suite under the shared-host
admission lock. Publication requires its completed receipt; the focused checks
above are not a replacement for that gate.

Final canonical receipt: tested revision
`fddd07befac58debc3efaf1bba99c9ee2a4d9a24`, with the reviewed source and
consuming-test hashes above unchanged. `bash scripts/check-shared-host.sh`
completed with exit zero: all 51 project typechecks passed; all 1,776 declared,
discovered and assigned test files executed; 27,646 tests passed, 24 skipped,
zero failed, and 130,788 assertions. All 19 bounded-memory lanes were green.
The runner's measured suite input identity remained
`4a673a0235722f6aa6070649cfd1badffe1ea952978d572dc29472e1138a6e26`.
The complete command ran in an isolated unregistered fixture environment,
without file selectors, retaining the effective user and proving the host's
registration and mount namespace unchanged afterward. This is a test-environment
receipt, not registered live provider acceptance. An earlier complete attempt
on `261e5dec0d55fc57fbc109f5b2c9e869a31fb1b0` failed on ambient route and
permission assumptions; it is not counted as passing proof. Final-head CI,
served deployment and fresh unattended workflow acceptance remain separate.
