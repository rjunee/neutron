---
title: Adopt Codex account custody and expose bounded operator rotation
group: trident
status: open
priority: P1
cutover: true
---

Decision: SPEC.md, 2026-09-27, Codex operator custody stays with the credential
service. Existing per-account homes remain the credential authority; a pointer
selects among them. No new quota polling cadence or automatic project selection
is introduced.

## Acceptance

- [ ] Generic credential create, overwrite and delete refuse normalized `codex`
      and `codex-acct-*`, including the reserved-write entry points for other
      modules. Explicit Codex-owned writes remain available. Existing credential
      reads, resolution and metadata listing are unchanged; unrelated services
      and owners remain writable. Verify:
      `bun test trident/codex-service-custody.test.ts
      gateway/http/__tests__/project-credentials-surface-scope.test.ts`.
- [ ] The service's process-local maintenance gate closes writer admission
      synchronously and drains previously admitted queue entries, harvest writes
      and status-probe metadata writes. Nested writes of admitted operations may
      finish; detached continuations cannot reuse a settled admission. While
      held, metadata-producing status/resolution paths refuse, and stored-only
      metadata/read paths remain available. HTTP refusals are 409 and do not
      change auth, credential or rotation data. Releasing an old lease cannot
      reopen a newer one. Verify:
      `bun test project-credentials/codex-custody-gate.test.ts
      trident/codex-service-custody.test.ts
      gateway/http/codex-credential-surface.test.ts`.
- [ ] Named rotation clears only the target's cooldown/quarantine, adds no
      departure cooldown and returns the actual pointer change. Plain rotation
      selects an eligible successor without adding departure cooling;
      no eligible successor is an explicit refusal without pointer changes.
      Expired/unusable grants cannot hide a later healthy successor, and cannot
      be selected when no healthy successor remains.
- [ ] Free one/all clears cooling and cached revocation without moving the active
      pointer, replacing credentials, or changing labels or grants; repeated free
      reports no change. Malformed and unknown slots refuse.
- [ ] Explicit adoption of an existing canonical account directory verifies an
      independently supplied account identity, refuses differing identities and
      ambiguous or regressing refresh timestamps, and persists the freshest exact
      live bytes without writing an auth file. Existing labels, finite grants,
      cooldowns, history and active pointers survive. Missing/unreadable auth and
      expired stored grants refuse; repeated adoption reports no change.
      Explicit initial metadata may seed a new slot's label and cooling deadline,
      carry forward a usage-attribution cutoff without reducing an existing one,
      and initialize the default pointer only when absent. A conflicting current
      pointer refuses before adoption. Existing slot cooldowns are never replaced
      by repeated migration input.
- [ ] Authenticated global POST routes `/api/app/codex-auth/rotate`, `/free`, and
      `/adopt` derive the owner from bearer auth. Project routes cannot operate the
      global pool and request-body owner fields cannot select another owner.
      GET `/api/app/codex-auth/rotation` reports the stored pointer and configured
      account metadata without probing, harvesting, or choosing a successor.
- [ ] General Admin shows the stored active Codex account and offers a manual
      "Switch to next available account" action. The action uses authenticated
      global metadata and plain rotation routes, disables when no alternate is
      available, holds the control busy through the confirming metadata read,
      ignores stale reads, shows the returned selection after success, and reports
      a 409 refusal without claiming a change. Connect and disconnect cannot
      overlap a switch in either direction, including same-tick submits. A 409
      re-reads stored selection without erasing the refusal. It is reachable in
      General and absent from named projects. No credential or bearer bytes render.
      An explicit named-account selector additionally sends `{ to }`, including
      destinations with stored cooldown/quarantine; it never silently falls back
      to plain rotation. A cooled target requires confirmation naming that target
      and explaining that selection clears stored cooling, not provider quota.
      Cancel sends no write. Both account directions, refusals and the shared
      connect/disconnect mutation boundary are tested through this action too.
      Selection is global, not a review-only account override. Existing server
      custody checks and General handoff admission/viability checks remain intact;
      switching itself does not attest fresh provider capacity.
      Verify: `bun test landing/chat-react/__tests__/codex-credential-client.test.ts
      landing/chat-react/__tests__/integrations-tab.test.tsx
      landing/chat-react/__tests__/reachability.test.tsx`.
- [ ] Synthetic service and HTTP tests exercise both success and refusal, and
      semantic mutations fail those checks. General account handoff retains idle
      admission, target viability and pre/post-retirement revalidation; explicit
      project grants remain required. The final consuming proof includes
      `open/__tests__/project-build-e2e.test.ts`.

Adoption is bounded to the service's established default and named account
directories. Arbitrary path import, live account migration and copying one login
into multiple live directories are outside this change.

## Operator contract

`rotateAccount(owner, { to? })`, `freeAccount(owner, slotOrAll)`, and
`adoptAccount(owner, { slot, accountId, initial? })` return an explicit refusal or
`{ ok: true, status, changed, active, accounts }`. Rotation also returns `from`
and `to`; its status distinguishes `rotated` from `already_active`. Free and
adoption distinguish `freed`/`already_free` and `adopted`/`already_adopted`.
Plain Codex rotation preserves existing departure cooldowns and adds none.

HTTP uses POST bodies `{ to? }`, `{ account }`, and `{ account, account_id, initial? }`
respectively. Malformed input is 400; custody/precondition refusal is 409.
Adoption reads only the server-derived canonical home; the request never
supplies credential bytes or arbitrary paths. `accountSelection(owner)` backs
the read-only rotation metadata route. Existing encrypted grant metadata is
preserved; adoption cannot renew an expired grant.

`initial` accepts only `label`, `coolingUntil`, `usageSince` and `active`.
Cooling/usage timestamps are nonnegative integer milliseconds. New rotation
rows may receive the label and deadline; a usage cutoff may only increase.
`active: true` explicitly initializes the default selection if absent, accepts
the same default selection, and refuses any different selection or named slot.
Repeated adoption cannot reset an existing cooldown or relabel an existing slot.
Unknown legacy metadata requires caller reconciliation, not reinterpretation.

Disconnect and adoption share the owner mutation queue. A queued disconnect
finishes before later adoption reads custody, preventing a removed grant from
being recreated. An unrelated owner's operation remains independent.

For an older account bank that copied its active account into the default home,
the current native default home must remain the default slot. A caller must
independently establish identity/freshness across any legacy duplicate before
adoption, keep a stable old-id-to-slot mapping, and adopt only distinct other
subscriptions at their existing named homes. This service does not infer the
mapping or perform the offline migration.

The write-admission gate covers participating store/service operations sharing
one `ProjectDb` object in one process. It does not survive a process restart,
exclude native CLI refreshers or other database connections, or authorize
reconciliation. A held service lease is not a host quiescence receipt. Native
writer exclusion and independent account mapping remain separate prerequisites.
