## Issue 599 — integrations show what is connected

### Built

The integrations status builder previously initialized its complete OAuth and API-key inventory from the registry's manifest declarations at `gateway/cores/integrations.ts:423-424`. The HTTP surface passed that registry into the builder at `gateway/http/cores-integrations-surface.ts:150-158`, so an owner-scoped credential without a Core manifest slot could not become a response row.

The builder now performs one owner-scoped, all-kinds `SecretsStore.list` inventory at `gateway/cores/integrations.ts:438-442`. It folds stored OAuth and API-key labels missing from the manifest maps into the response at `gateway/cores/integrations.ts:443-458`. The source enumeration used `rg -n "kind: 'oauth_token'|kind: 'byo_api_key'" github gateway auth onboarding cores`; the same search found the positive-control GitHub writer at `github/credential.ts:66-70`, the Core OAuth writer at `gateway/cores/oauth-token-manager.ts:384-387`, and the API-key writer at `auth/api-key-store.ts:101-104`. Adding `kind: 'bot_token'` to the identical search was the positive control for a stored kind deliberately outside this surface.

Connection state joins the explicit `ConnectionState` vocabulary at `gateway/cores/integrations.ts:126-132`: `connected`, `not_connected`, and `unknown`. The OAuth builder classifies that vocabulary at `gateway/cores/integrations.ts:484-500`; the API-key builder does the same at `gateway/cores/integrations.ts:521-530`. A failed inventory or status read becomes `connected: null` and `connection_state: unknown`, never false. The existing clients render null as “Could not determine” at `app/lib/integrations-view.ts:67-74` and `landing/chat-react/integrations-oauth-view.ts:61-65`. This vocabulary is maintained on every status build from the read result itself and does not depend on the failed store recovering.

The HTTP payload now identifies the expanded inventory at `gateway/http/cores-integrations-surface.ts:160-167`. The CI-discovered real HTTP surface test exercises connected, absent, and failed-read responses at `gateway/__tests__/cores-integrations-surface.test.ts:147-203`; discovery is performed by `scripts/run-tests.sh:238-244`, whose zero-file refusal keeps the guard armed.

### Decisions

The existing manifest rows remain as available connection targets, while stored credentials supply additional connected rows. This preserves a genuinely absent Core slot while removing the static-catalogue ceiling. `connected` remains on the wire for existing consumers but becomes nullable; `connection_state` supplies the named three-way taxonomy so clients do not infer null semantics independently.

Secret plaintext is never read by the new inventory: `SecretsStore.list` returns records at `auth/secrets-store.ts:283-299`, and the response continues to expose only identifiers and metadata. The real-surface test asserts the seeded credential value does not occur in the serialized payload at `gateway/__tests__/cores-integrations-surface.test.ts:173-174`.

### Mutation table

| Guard | Mutation and landing line | Red result | Restored result |
|---|---|---|---|
| Stored OAuth labels enter the inventory | Added `false &&` to the OAuth-kind branch at `gateway/cores/integrations.ts:444`; printed that line before the run | Connected non-Core row assertion failed because the row was absent | Focused aggregation test: 1 pass |
| A genuinely absent slot stays absent | Replaced the status value with literal true at `gateway/cores/integrations.ts:484`; printed that line before the run | Calendar expected false/not_connected but received true/connected | Focused aggregation test: 1 pass |
| Read failure is indeterminate | Replaced the null branch with false at `gateway/cores/integrations.ts:484`; printed that line before the run | Failed-read fixture expected null/unknown but received false/not_connected | Focused aggregation test: 1 pass |

### Verification

`bun test gateway/cores/__tests__/integrations.test.ts app/__tests__/integrations-view.test.ts landing/chat-react/__tests__/integrations-oauth-view.test.ts landing/chat-react/__tests__/integrations-client.test.ts` passed 34 tests. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations. `bash scripts/ci/lint.sh` passed every repository lint gate.

The CI-discovered HTTP file could not run locally because this build sandbox rejects `Bun.serve({ port: 0 })` before any test assertion. Both attempted runs failed all cases at the common server-bind line `gateway/__tests__/cores-integrations-surface.test.ts:93`; this is recorded rather than misreported as assertion evidence.

### Deliberately not done

No new credential store, static provider catalogue, feature flag, migration, plaintext read, connection mutation, or alternate response path was added. Credential kinds other than OAuth tokens and owner-provided API keys remain outside this integrations classification because their presence does not mean the owner connected an external integration.
