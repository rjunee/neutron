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
  With only one configured account occupied by a project or General owner,
  independent Codex review/build calls defer rather than clone authentication,
  stop that owner, or silently claim completion. They require account release
  or an independently available account.
  Distinct-account native consumers remain available. Shared-file synthetic
  fixtures alone do not satisfy this consuming acceptance.
  A conclusively pre-native account refusal is retryable after account release,
  without fabricating retirement or leaving a phantom durable owner. Unknown
  launches, foreign refusal receipts and any native journal remain fenced.
  The account census excludes a kernel task only after two readable Linux stat
  observations agree on its PID, start time and flags including `PF_KTHREAD`.
  Empty argv or a missing executable alone never permits exclusion; unreadable
  userspace tasks, malformed stat and changed kernel evidence remain unknown.
  The admission observation protocol below governs local and protected observers.
  Verify: `runtime/adapters/codex-cli/persistent/project-owner-admission-refusal.test.ts`,
  `runtime/adapters/codex-cli/account-writer-lock.test.ts`,
  `runtime/adapters/codex-cli/persistent/project-control-bootstrap-account-lease.test.ts`,
  `trident/codex-review.test.ts`, `trident/codex-build.test.ts`,
  `open/__tests__/codex-durable-owner.test.ts`.
- [ ] A Codex project orchestrates an actual build through completion on Codex.
  Depends on [the project REPL orchestration change](the-orchestrator-owns-the-build-loop.md)
  (#545). Substrate selection alone does not replace the native Workflow launcher.

## Account admission observation protocol v1

The canonical classifier is Python module
`runtime/adapters/codex-cli/codex_account_observation.py`:
`observe_uid(uid, proc=Path('/proc'), max_processes=65536, timeout_ms=2000)`
returns exactly `{nativeConsumers: [{pid, startTicks, accountId}],
scannedProcesses}` or raises `ObservationUnknown` with a bounded reason code.
`account_identity(path, uid)` returns the opaque account ID. The protected
observer imports these reviewed bytes; it must not maintain a second classifier.
PID and UID are JSON integers, start ticks are canonical decimal strings. Account
IDs are lowercase SHA-256 hex of the bytes
`b'neutron-codex-account-v1\0' + os.fsencode(canonical_absolute_path) + b'\0'
+ ascii(device) + b':' + ascii(inode)` for an existing directory owned by the
verified real UID. Neither account credentials nor their digest are involved.

Root provisions `/etc/neutron/codex-observer/<real-uid>.json`, with exactly
`{version: 1, kind: 'codex-observer-pin', instanceId, hostId, socketPath,
publicKey}`. The public key is Ed25519 SPKI PEM; identifiers are 1–128 ASCII
letters, digits, dots, underscores or hyphens. The file and every ancestor are
root-owned, not group/world writable and not symlinks. Its absence selects
complete local observation. Its presence selects the protected observer;
unreadable, malformed, unavailable or refusing configuration never falls back.
The endpoint is an absolute protected Unix socket. This selection is operator
deployment configuration, not a runtime feature flag or a second classifier.

Each direction carries one strict UTF-8 JSON object followed by LF and EOF (the
client half-closes its write side after the request). Duplicate
keys, extra fields, non-finite numbers, extra frames and invalid encodings refuse.
Request (maximum 1,024 bytes): exactly `{version: 1,
kind: 'codex-live-census-request', instanceId, challenge}`; challenge is 32 random
bytes encoded as 64 lowercase hex characters. No PID, UID, path, environment,
argv or namespace query selector is accepted. Before parsing the request, the
server must acquire the connected caller's kernel `SO_PEERPIDFD`, retain it
through response, reconcile SO_PEERCRED with all four proc UIDs and stable
PID/start, and revalidate liveness around observation and signing. Reopening a
numeric PID does not satisfy this prerequisite.

Success is exactly `{payload, signature}`. Signature is canonical padded base64
of the 64-byte Ed25519 signature over UTF-8 JSON of payload with sorted keys,
no whitespace, ASCII escaping and no non-finite numbers. Payload is exactly
`{version: 1, kind: 'codex-live-census', instanceId, uid, hostId, bootId,
challenge, caller: {pid, startTicks}, startedMonotonicNs,
finishedMonotonicNs, bounds: {maxProcesses: 65536, maxDurationMs: 2000},
scannedProcesses, nativeConsumers: [{pid, startTicks, accountId}]}`.
Monotonic nanoseconds are canonical decimal strings from `CLOCK_MONOTONIC`;
boot ID is the canonical lowercase UUID from the kernel. Consumers are unique,
sorted by PID, maximum 4,096; scannedProcesses is an integer from 1 to 65,536.
The client checks the protected pin, signature, every exact schema and binding,
its own PID/start/real UID, current boot, fresh challenge, and scan start/end
inside its request interval (maximum 3 seconds), before interpreting consumers.
Response maximum is 1 MiB. The observer closes the connection after one response.
The Linux client uses `/usr/bin/openssl` for Ed25519 verification, with anonymous
memory descriptors for the public key, signed bytes and signature. Missing or
unsupported verification is unknown; no executable is selected through PATH.

Refusal is exactly `{version: 1, kind: 'codex-live-census-refusal', reason}`,
where reason is one of `peer`, `request`, `incomplete`, `changed`, `budget`,
`unavailable`. Refusals carry no successful observation and always fence
admission; unsigned refusal cannot grant permission. Disconnect, timeout and
every validation failure are also `accountAdmissionUnknown`.

The classifier derives population membership from all four credential UID
fields, never proc inode ownership. A relevant live userspace process requires
stable PID/start, credentials, executable and classification evidence before
exclusion. A Codex consumer uses observed nonempty CODEX_HOME, then observed
HOME/.codex, then verified-real-UID NSS home/.codex; relative paths use stable
observed cwd. NSS, namespaces, account path and device/inode must remain stable.
NSS fallback requires the target and observer to share the mount namespace and
root filesystem identity. A matching root inode alone does not prove the same
NSS database or providers. A protected observer with a distinct read-only mount
namespace therefore refuses missing-HOME/CODEX_HOME consumers as unknown. Native
launch supplies explicit canonical CODEX_HOME; explicit HOME/CODEX_HOME may cross
mount namespaces only with target-root account path/device/inode equivalence.
No process-name exception or ignored read error establishes completeness.
The server proves its complete host proc view separately, then revalidates boot,
enumeration and all classification evidence; budget exhaustion is unknown.

Launch and auth mutation invoke the same observation client while holding their
existing account reservation. Matching account identity returns `accountBusy`;
complete distinct accounts admit. The actual native retains the lifetime lock
after helper death. The client revalidates its account identity around observation
and lock handoff. Observation is not an atomic kernel snapshot or a lease against
later unwrapped launches. No credential read, copied account, process control,
service control or reusable receipt is introduced.

Acceptance requires valid same/distinct-account controls, NSS fallback, unknown
and malformed/reforged/replayed response controls, changed process/account/boot
controls, plus reservation and native-lifetime tests in both admission orders.
The focused Python observation suite and existing account-writer suites run
before the consuming tests listed above. The integrating gate also runs
`open/__tests__/project-build-e2e.test.ts` and all owned TypeScript projects.
