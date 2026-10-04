---
title: Resolve the model provider per instance and project
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#869"
---

Within the harness hierarchy, the most specific explicit choice wins: project override, instance default,
application default (Claude Code). A null project override follows live instance
changes; an explicit Claude Code choice does not. Resolution includes its source.
An unwired selection refuses visibly instead of falling back to another provider.
An explicit [configured API project route](configured-models-for-review-and-chat.md)
selects the conversational model before this hierarchy (Decisions Log 2026-09-15,
configured model access); the provider settings continue to describe the harness.

### Configuration

After migrating the instance database, provisioning and live updates use:

```sh
bun open/instance-model-provider.ts <database> <instance> openai-codex
bun open/instance-model-provider.ts <database> <instance> inherit
```

The former environment setting is imported once on first boot after migration.
An explicit stored choice, including inheritance, survives subsequent restarts.
The existing project settings PATCH sets `model_provider`; null clears the override.
Credentials still need to be configured for the selected adapter.

Web and phone project settings expose inheritance, explicit Claude Code and explicit
Codex. The selection can be saved before credentials are connected. The settings
show the resolved harness and its source; configured API routes retain the priority
described above, and changing harnesses does not transfer native conversation context.

Native Codex owners require an explicit project credential and matching full project
ownership marker. Global reviewer seats are not project owner grants. Before each
new chat, control or build admission, an existing owner is checked against the current
project grant and its stable subscription account identity. Refreshing tokens for the
same account preserves that identity; removing the grant or replacing its account
refuses admission without opening a replacement owner. Exact-turn interruption and
declining a pending approval remain available to settle existing work. Reviewer inheritance and
rotation retain their existing scope.
Harvesting refreshed token bytes preserves the existing grant expiry; refresh does
not extend a finite project grant.

An authenticated project selection may reference an existing configured account
by source credential row ID and stable account digest, with a versioned grant
and optional finite expiry (Decisions Log 2026-10-04). Selection stores metadata
only; the native account home remains authoritative. Project ownership markers,
durable owner journals, work records and control sockets remain project-scoped.
Removing/recreating either source row or project grant invalidates the old binding.
Independent project subscriptions retain their own account home. Existing owners
whose persisted scope predates grant identity require explicit reconciliation;
the upgrade never fabricates a grant identity for their old launch record.

The project Codex status includes `owner_credential`: configuration (`true`, `false`,
or `null` when inspection could not conclude), observation time and explanation. This
is a local credential check, not a claim of live owner/build/restart acceptance (#978).

### Acceptance

- [x] Separate instance databases accept independent defaults, including Codex.
  Verify: `open/__tests__/instance-model-provider.test.ts`.
- [x] Unset projects follow a live instance change; explicit projects retain their choice.
  Verify: `open/__tests__/instance-model-provider.test.ts`.
- [x] A first Codex project selected after credentialless boot reaches chat intake
  and opens the browser chat page without a restart. Missing credentials and revoked grants still refuse; switching
  away from Codex does not reuse its owner. Verify:
  `open/__tests__/open-wiring-substrates.test.ts`,
  `open/__tests__/open-trident-prod-boot-wiring.test.ts`,
  `open/__tests__/open-wiring-landing.test.ts`.
- [x] Dispatch with a project ID resolves that project's provider independently of
  the active chat fallback. Verify:
  `gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`.
- [x] The project settings inspection exposes the resolved provider and source.
  Verify: `gateway/__tests__/app-projects-surface.test.ts`.
- [x] Build substrate dispatch reaches Codex without a Claude dispatch, paired with
  a positive Claude control. Verify: `open/__tests__/open-wiring-substrates.test.ts`.
- [x] Unwired selections name the requesting level.
  Verify: `gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`.
- [x] Web and phone settings save either harness and inheritance through the project
  route, show failed writes without claiming success, and keep project changes isolated.
  Pending and failed credential reads expose no previous project's status or removal
  control; a failed read remains unknown, not disconnected.
  Verify: `landing/chat-react/__tests__/project-chat-settings.test.tsx`,
  `app/__tests__/project-chat-settings.test.tsx`.
- [x] A global reviewer connection remains insufficient for a native project owner.
  An explicit project connection succeeds; expired grants, currently probed revocations,
  foreign accounts and ownership mismatches refuse. Same-account native token refresh
  remains valid. Verify: `trident/codex-credential.test.ts`,
  `gateway/http/codex-credential-surface.test.ts`.
- [x] Cached owners revalidate the project grant before subsequent chat, control and
  build admissions, without spawning a replacement owner on refusal.
  Verify: `open/__tests__/codex-owner-binding.test.ts`,
  `open/__tests__/open-trident-prod-boot-wiring.test.ts`.
- [ ] Selecting a configured account writes no credential bytes and creates no
  additional auth file. Two explicitly granted projects share canonical account
  refreshes while retaining separate full-project markers, sockets and journals.
  Revocation, replacement, source recreation, foreign owner and finite expiry
  refuse; same-account refresh succeeds without extending the grant.
  Verify: `trident/codex-project-grant.test.ts`,
  `gateway/http/codex-credential-surface.test.ts`,
  `open/__tests__/codex-owner-binding.test.ts`,
  `open/__tests__/codex-durable-owner.test.ts`.
- [ ] One canonical account admits one native refresh writer at a time, including
  project/General owners, probes, exec, reviewer/build and standalone session
  consumers. The lock survives gateway/helper death while native work remains;
  competing admission and auth-file mutations refuse visibly as account busy.
  Distinct-account native consumers remain available. Shared-file synthetic
  fixtures alone do not satisfy this consuming acceptance.
  A conclusively pre-native account refusal is retryable after account release,
  without fabricating retirement or leaving a phantom durable owner. Unknown
  launches, foreign refusal receipts and any native journal remain fenced.
  Verify: `runtime/adapters/codex-cli/persistent/project-owner-admission-refusal.test.ts`,
  `open/__tests__/codex-durable-owner.test.ts`.
- [ ] A Codex project orchestrates an actual build through completion on Codex.
  Depends on [the project REPL orchestration change](the-orchestrator-owns-the-build-loop.md)
  (#545). Substrate selection alone does not replace the native Workflow launcher.
