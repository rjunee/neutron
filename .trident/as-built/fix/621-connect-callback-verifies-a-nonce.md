## 2026-09-14 — Verify connect callback state before redemption

### Scope and evidence

Delivered the callback security portion of #621. Production composition remains
open, as explicitly permitted by the lane task. The acceptance contract lives in
`docs/spec-items/connect-auth-session-nonce.md`; its index was regenerated.

At the initial read, `gateway/http/app-connect-auth.ts:205` redeemed a code
without state verification. The search
`rg -n 'nonce|state|connectViaRedeem' gateway/http/app-connect-auth.ts`
returned the redeem call and the unrelated state comment at original line 214;
`connectViaRedeem` was the positive control. Factory and slot references were
enumerated with
`rg -n 'createAppConnectAuthSurface|app_connect_auth_surface' --glob '*.ts'`.
The factory declaration and test calls were positive controls; the results had
no production factory invocation. This is a working-tree content claim, not a
claim about a fetched remote ref.

### Implementation and decisions

- The verifier must supply a stable login-session ID, distinct across logins of
  the same user (`gateway/http/app-connect-auth.ts:73`). The stored key includes
  project, user, and session (`gateway/http/app-connect-auth.ts:150`).
- Start generates 32 random bytes and stores the nonce under that key before
  returning the auth URL (`gateway/http/app-connect-auth.ts:219`). The callback
  compares the returned query value with that saved nonce, not with itself
  (`gateway/http/app-connect-auth.ts:240`). The shared equality primitive handles
  length differences and calls timingSafeEqual (`runtime/constant-time-equal.ts:33`).
- Attempts expire after ten minutes; callback-time expiry verification maintains
  this invariant even if the browser or identity service fails. Used state is
  set synchronously before redemption awaits, preventing concurrent reuse
  (`gateway/http/app-connect-auth.ts:238`, `gateway/http/app-connect-auth.ts:244`).
- State is process-local and one attempt is retained per session. A new start
  replaces that session's attempt and sweeps expired entries
  (`gateway/http/app-connect-auth.ts:216`). Restart loses state and callbacks
  refuse via the missing-attempt branch (`gateway/http/app-connect-auth.ts:237`).
  Horizontal sharing and persistence are deliberately outside this change.

### Outcome vocabulary and consumers

The existing callback vocabulary is `connect=connected|error`; redemption errors
are `FederatedConnectError` (`gateway/connect/federated-token-store.ts:74`). The
callback maps that class to `connect=error` and rethrows other exceptions
(`gateway/http/app-connect-auth.ts:254`). Nonce refusals are handled responses
before the redeem try block, so they cannot accidentally become an unclassified
exception. They retain `connect=error`, add `connect_error=failed_verification`
or `could_not_verify`, and log the reason (`gateway/http/app-connect-auth.ts:151`).
Missing/wrong state on an available attempt uses failed verification; unavailable,
expired, and used attempts have distinct refusal checks
(`gateway/http/app-connect-auth.ts:237`). Authentication failures retain the
existing HTTP 401 `unauthorized` response and log could-not-verify
(`gateway/http/app-connect-auth.ts:189`). A verified comparison is logged before
redemption (`gateway/http/app-connect-auth.ts:245`); it does not assert redemption
succeeded.

The route-slot consumer forwards the handler response without reclassification
(`gateway/http/route-slots.ts:607`). The default log consumer is the repository
warn logger (`gateway/http/app-connect-auth.ts:145`), subject to its standard
severity filter (`logger/index.ts:263`). Logs contain outcome/reason only.
Direct connect query readers and error-symbol references were enumerated using
`rg -n "searchParams.get\(['\"]connect['\"]|connect_error|FederatedConnectError"`
over TS, TSX, HTML and JS files. The surface's error writer and tests were
positive controls; this search did not find a production UI reader of the new
query field. The existing error marker is therefore preserved without relying
on a new UI consumer.

### Tests and mutation evidence

`gateway/http/app-connect-auth-nonce.test.ts:48` proves a legitimate round trip;
`:58` omits state from a real pending attempt; `:67` crosses two live sessions of
the same user; `:80` replays a redeemed attempt. Additional tests at `:89`, `:98`,
`:107`, `:116`, and `:125` exercise expiry, unavailable state, authentication,
incomplete verifier output, and concurrent callbacks.

Each mutation was applied alone, its actual landing line printed, its focused
test observed RED, then the original code restored and the same test observed
GREEN. Missing-state acceptance substitutes the stored nonce when state is absent;
this deliberately defeats the later comparison too, proving a real acceptance
regression rather than merely moving rejection to the next guard.

All line numbers in the following table refer to `gateway/http/app-connect-auth.ts`.

| Guard and landing line | Mutation | Broken | Restored |
|---|---|---|---|
| missing nonce classification (:241) | `if (!state) return refuse(dest, 'could_not_verify', 'missing_nonce')` | RED | GREEN |
| missing nonce acceptance (:240) | `const state = url.searchParams.get('state') ?? attempt.nonce` | RED | GREEN |
| nonce comparison (:242) | `if (false)` | RED | GREEN |
| session binding (:150) | `JSON.stringify([claim.project_slug, claim.user_id])` | RED | GREEN |
| replay refusal (:239) | `if (false)` | RED | GREEN |
| single use consumption (:244) | `attempt.used = false` | RED | GREEN |
| expiry refusal (:238) | `if (false)` | RED | GREEN |
| pending attempt requirement (:236) | `const attempt = pending.get(sessionKey(claim)) ?? { nonce: url.searchParams.get('state')!, expires: now() + 1000, used: false }` | RED | GREEN |
| session identifier requirement (:199) | `if (false)` | RED | GREEN |
| legitimate comparison direction (:242) | `if (constantTimeEqual(state, attempt.nonce))` | RED | GREEN |

### Validation and deliberate limits

- 68 tests passed: the three HTTP callback/session files plus the spec-index
  tests. No whole-suite run was attempted.
- Repository lint passed. Gateway typecheck passed after fixing three test-only
  Request constructors to pass strings.
- The served composition test cannot bind port 0 in this environment:
  EADDRINUSE at `gateway/__tests__/connect-auth-open-mode-production-composer.test.ts:102`.
  An independent minimal Bun listener reproduced it. Its assertions remain
  intact; this is an unverified served test, not a green result.
- Production composition is deliberately not enabled. The existing Open claim
  returns only project and user (`open/composer.ts:2031`); the session signer
  encodes slug and expiry (`landing/session-cookie.ts:56`). Adding a guessed
  constant session ID would defeat session binding. Session issuance and the
  identity-service configuration must be settled before a production composer
  can satisfy the new contract.
- Corrected the injected-composition test's boot claim
  (`gateway/__tests__/connect-auth-open-mode-production-composer.test.ts:3`) and
  the slot comment (`gateway/composition/input/app-surfaces-input.ts:173`). A
  whole-tree sweep of their distinctive phrases also found
  `trident/orchestrator.test.ts:261`; that unrelated orchestration comment stays.
- No bypass, deployment flag, cookie-format migration, or provider-service
  change was introduced. SPEC decisions were not changed.
- The task explicitly requires this branch-named staging shard under
  `.trident/as-built/`; that instruction takes precedence over the default
  `docs/as-built/` location. Re-read the work-tracking standard before writing it.

### Final gate results

The full typecheck runner checked all 51 configurations: 50 passed and gateway
failed on the three Request constructor types, subsequently corrected. A focused
`bunx tsc -p gateway/tsconfig.json --noEmit` rerun passed. The full runner's
original exit remains 1; the corrected failing configuration was rerun separately.
The root scripts are at `package.json:57`. The search
`rg -n '"typecheck"|"start"' package.json` found start as its positive control,
but no typecheck script; the repository matrix command was used instead.

`bash scripts/ci/leak-gate.sh --tree .` exited 3, INCOMPLETE: zero findings from
executed rules, but the private PII file/message denylist was unavailable. This
must be completed by the orchestrator and is not reported as green. No push,
PR creation, or merge was attempted.
