## 2026-09-14 — Diagnose the blocked trusted membership composition (#622)

### Outcome and scope

Diagnostic evidence only; #622 is NOT fixed. The production authority policy
explicitly excludes trusted accept (`open/wiring/connect-node.ts:22`). Completing
central membership registration requires deciding which remote identity authority
Open trusts and where registration is written. This lane does not invent that
product decision or broaden the adjacent auth work.

The filed premise needs a correction: Open mounts Connect directly through
`buildConnectNodeWiring` (`open/composer.ts:6558`); the adapter hook stays undefined
by design (`runtime/platform-adapter-local.ts:144`). The optional registration
seams remain at `connect/member-join.ts:230,287` and
`connect/trusted-accept-handler.ts:74,159`.

### Reachability evidence

Enumerated production TypeScript with:

```sh
rg -n 'MembershipStore|buildSharedProjectsResolver|buildTrustedAcceptHandler|buildConnectNodeWiring' --glob '*.ts' --glob '!**/__tests__/**' --glob '!**/*.test.ts'
```

The trusted-handler and shared-resolver matches are declarations at
`connect/trusted-accept-handler.ts:95` and
`gateway/projects/shared-projects-resolver.ts:133`, with membership references in
comments. The SAME search finds the positive control, an actual production
invocation at `open/composer.ts:6558`. A second enumeration:

```sh
rg -n 'registerMembership|connectApiHandlers|buildConnectNodeWiring' --glob '*.ts' --glob '!**/__tests__/**' --glob '!**/*.test.ts'
```

finds the optional declaration/forward/call chain above but no production
registration supplier; the composer invocation is again the positive control.
These are working-tree searches, not assertions about a freshly fetched ref.
Network operations were not attempted.

### Executable diagnosis

Added `open/__tests__/open-connect-membership-composer.test.ts`. Its harness
constructs frozen boot config, calls the real Open composer and then the production
graph (`open/__tests__/open-connect-membership-composer.test.ts:84-86`); it injects only a transport peer for HTTP dispatch (`open/__tests__/open-connect-membership-composer.test.ts:93-96`).
The existing exemplar was read at
`open/__tests__/open-connect-served.test.ts:125-139`: it constructs both stages,
which is the property needed here. Its socket listener could not bind port 0 in
this environment. The new diagnostic dispatches Requests in process and claims
no listening-socket coverage.

The owner issues an invite through the composed HTTP surface (`open/__tests__/open-connect-membership-composer.test.ts:114`), the guest
redeems it (`open/__tests__/open-connect-membership-composer.test.ts:131`), and that returned bearer lists the joined project (`open/__tests__/open-connect-membership-composer.test.ts:150`).
The SAME authenticated bearer gets the route-specific trusted-accept 404 (`open/__tests__/open-connect-membership-composer.test.ts:161`).
A second invite keeps the surface open before owner revocation (`open/__tests__/open-connect-membership-composer.test.ts:170-176`),
so the membership check is reachable: that bearer then sees an empty project
list (`open/__tests__/open-connect-membership-composer.test.ts:177-179`). This proves the existing guest behavior, not central token
registration or the invitee's unified app list.

The existing outcome vocabulary is unchanged: the absent trusted handler returns
404 `not_found` (`connect/api/server.ts:284-289`), an unwired list returns 501
`not_implemented` (`connect/api/server.ts:416-422`), and the composed nonmember
list returns an empty array (`open/wiring/connect-node.ts:114`) serialized as
200 by `connect/api/server.ts:434`. No new runtime guard or outcome was added.
The member is resolved from storage on each list request
(`open/wiring/connect-node.ts:110`), independently of the revoked client cooperating.

### Mutation controls

Each mutation was applied alone, its actual landed line printed, the diagnostic
run, and the original bytes restored. All three went RED; restored test GREEN.

| Existing property | Mutation and landed line | RED evidence | Restored |
| --- | --- | --- | --- |
| Production list wiring | `list_projects: undefined` at `open/wiring/connect-node.ts:190` | expected 200, got 501 | GREEN |
| Nonmember exclusion | return a project for null member at `open/wiring/connect-node.ts:114` | expected empty projects, got project | GREEN |
| Trusted-route diagnosis reaches dispatch | absent handler status changed to 418 at `connect/api/server.ts:287` | expected 404, got 418 | GREEN |

The last mutation demonstrates the diagnostic is past authentication and the
surface gate; it is not a claim that trusted registration has been implemented.

### Deliberately not changed

No production behavior, trust policy, signing issuer, membership writer, spec
decision, or callback refusal was changed. #621 requires a verified session ID
(`gateway/http/app-connect-auth.ts:199`), while Open's current cookie resolver
returns only owner/user identity (`open/composer.ts:2033-2036`). That prerequisite
is reported to the orchestrator instead of bypassed.

This single record is staged at the lane-requested `.trident/as-built/` branch
path, following the explicit task override of the repository's default location.

### Validation

- `bun test open/__tests__/open-connect-membership-composer.test.ts gateway/http/app-connect-auth-nonce.test.ts`: 10 passed, 62 assertions.
- `bash scripts/ci/lint.sh`: passed all reported checks.
- `git diff --cached --check`: passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, zero findings in executed
  rules, unavailable private denylist; incomplete, not clean.
- `bash scripts/ci/typecheck-all.sh`: 51 configs exercised; 50 passed on the
  first run. Root reported TS2352 for the partial transport fixture at
  `open/__tests__/open-connect-membership-composer.test.ts:93`. After making the
  test-only cast explicit through `unknown`, `bunx tsc -p tsconfig.json --noEmit`
  passed. The diagnostic and nonce tests were rerun after this correction and
  passed again (10 tests, 62 assertions).
