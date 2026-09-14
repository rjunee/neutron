## 2026-09-14 — Owner-scoped GitHub disconnect and reconnect (#589)

### Change and acceptance evidence

A saved GitHub token can be removed through `DELETE /api/app/github-auth` and the mobile Integrations screen. The route returns `not_connected` with separate `removed` and `cancelled` booleans; a repeated disconnect honestly reports no row removed (`gateway/http/github-connect-surface.ts:126`). The client exposes disconnect (`app/lib/github-connect-client.ts:89`) and the screen offers it for connected and pending accounts (`app/app/integrations.tsx:770`). Reconnecting uses the existing device flow (`app/app/integrations.tsx:248`).

The credential helper lists only the authenticated owner's OAuth rows, selects the GitHub label, and deletes that row by id (`github/credential.ts:90`). The underlying operation is a SQL DELETE, not a visibility marker (`auth/secrets-store.ts:395`). Existing rows retain their original coordinates and require no migration; expired or undecryptable rows are removable because deletion reads metadata instead of decrypting (`auth/secrets-store.ts:283`, `gateway/http/__tests__/github-disconnect.test.ts:65`).

Acceptance is covered by executable checks:

- Remove a populated legacy-format row, observe its disappearance from store listing and credential resolution, preserve another owner and another label, then reconnect with a different token: `gateway/http/__tests__/github-disconnect.test.ts:41`.
- Refuse unauthenticated deletion and prevent a caller from choosing another owner via request parameters: `gateway/http/__tests__/github-disconnect.test.ts:75`.
- Preserve storage failures as failures, rather than successful absence: `gateway/http/__tests__/github-disconnect.test.ts:84`.
- Cancel an old flow without allowing it to write or clear the replacement flow: `gateway/http/__tests__/github-disconnect.test.ts:94`.
- Wait for a write already executing, then remove its row: `gateway/http/__tests__/github-disconnect.test.ts:117`.
- Cancel before upstream code issuance returns: `gateway/http/__tests__/github-disconnect.test.ts:177`.
- Press Disconnect and reconnect in the rendered app/app/integrations.tsx: `app/__tests__/github-connect-reachable.test.tsx:488`. Reject malformed replies and stale polls: `app/__tests__/github-connect-reachable.test.tsx:499`, `app/__tests__/github-connect-reachable.test.tsx:517`, `app/__tests__/github-connect-reachable.test.tsx:547`.

### Ownership, continuous enforcement, and outcomes

Ownership remains the established instance-owner boundary, not a new user-id field on old rows. Production supplies `appOwnerAuth` (`open/composer.ts:4877`), whose owner-only resolution is enforced at `open/composer.ts:3563` and `open/composer.ts:3581`. The surface derives the storage handle from that resolved identity (`gateway/http/github-connect-surface.ts:121`); metadata selection carries the same handle (`github/credential.ts:94`).

A per-owner queue serializes requests and credential commits (`gateway/http/github-connect-surface.ts:95`). Every flow receives a guarded store capability: its identity must still be active when its write reaches that queue (`gateway/http/github-connect-surface.ts:210`). Disconnect invalidates that identity, independently of the remote poll completing (`gateway/http/github-connect-surface.ts:127`). Presentation and completion also check identity so an old flow cannot replace or clear a newer code (`gateway/http/github-connect-surface.ts:202`, `gateway/http/github-connect-surface.ts:219`). The queue releases before waiting for an upstream code (`gateway/http/github-connect-surface.ts:284`). These mechanisms maintain local removal even when the cancelled flow later resumes.

The response vocabulary remains `connected`, `awaiting_owner`, and `not_connected` (`app/lib/github-connect-client.ts:31`). A start cancelled before presentation joins the existing HTTP error envelope as `409 github_connect_cancelled` (`gateway/http/github-connect-surface.ts:189`, `gateway/http/surface-kit.ts:134`). The generic client error branch preserves its code and message (`app/lib/github-connect-client.ts:111`); the screen displays the message through the existing Error fallback (`app/app/integrations.tsx:1186`). It is not a fabricated upstream `DeviceFlowFailure`: a later cancelled presentation/write rejects into the existing `github_device_flow` rejection accounting and `github_connect_error` log branch (`gateway/http/github-connect-surface.ts:245`, `gateway/http/github-connect-surface.ts:254`).

Missing metadata produces `removed: false`; failed metadata lookup or deletion rejects (`github/credential.ts:94`). A malformed DELETE success produces `GitHubConnectError('protocol_error')`, not an inferred disconnected state (`app/lib/github-connect-client.ts:119`). Screen request revisions prevent earlier success or failure responses from overwriting a completed disconnect (`app/app/integrations.tsx:193`, `app/app/integrations.tsx:269`).

### Decisions and limits

This implements local credential removal and rotation by disconnect/reconnect. It does not revoke authorization at GitHub or erase copies already held by running commands: `githubProcessEnv` hands out a string in a process environment (`github/credential.ts:122`), and the test retains that old copy after deletion (`gateway/http/__tests__/github-disconnect.test.ts:43`). The screen explains this boundary and directs the owner to GitHub settings for upstream revocation (`app/app/integrations.tsx:811`). Pending polling may continue until its next completion/failure; the guarded write refuses persistence regardless (`gateway/http/github-connect-surface.ts:210`).

Deliberately did not change the generic secrets schema, upstream validity probing, process termination, other integration clients, or SPEC decisions. The existing Codex disconnect exemplar was read for its real removal and no-op semantics (`gateway/http/codex-credential-surface.ts:184`); this route reports idempotent absence explicitly rather than copying its 404 response. The filed storage/route line references were accurate at the base; the issue's “write-once” described the product flow, while storage already supported replacement (`github/credential.ts:54`).

### Mutation evidence

Each mutation ran alone. Before each run, the changed landing line and file diff were printed; the test went RED, the original bytes were restored, and the same test went GREEN. The two multiline mutation landing prints were repeated using the actual changed-line offset, rather than a matching context line. The table enumerates all 20 mutation cases run for this change. Test names below are filters in the two test files cited above.

| Guard or behavior | Mutation | RED test | Restored |
| --- | --- | --- | --- |
| Owner selection, github/credential.ts:94 | Select the other owner's rows | disconnect physically removes | GREEN |
| GitHub label, github/credential.ts:95 | Select unrelated label | disconnect physically removes | GREEN |
| Missing row, github/credential.ts:96 | Return true for missing row | disconnect physically removes | GREEN |
| Real removal, github/credential.ts:97 | Omit store.delete | disconnect physically removes | GREEN |
| Write identity, gateway/http/github-connect-surface.ts:211 | Disable identity refusal | cancelled flow cannot store | GREEN |
| Completion identity, gateway/http/github-connect-surface.ts:202 | Unconditionally clear active flow | cancelled flow cannot store | GREEN |
| Presentation identity, gateway/http/github-connect-surface.ts:219 | Remove refusal | before the upstream code request returns | GREEN |
| Queue serialization, gateway/http/github-connect-surface.ts:96 | Run action without predecessor | DELETE waits | GREEN |
| Queue cleanup identity, gateway/http/github-connect-surface.ts:99 | Unconditionally clear queue entry | DELETE waits | GREEN |
| Expiry invalidation, gateway/http/github-connect-surface.ts:110 | Keep expired flow active | expired pending flow | GREEN |
| Concurrent start reuse, gateway/http/github-connect-surface.ts:169 | Disable reuse | concurrent starts | GREEN |
| Pre-code cancellation, gateway/http/github-connect-surface.ts:127 | Omit cancel notification | before the upstream code request returns (timeout) | GREEN |
| Delete invalidation, gateway/http/github-connect-surface.ts:128 | Check identity without deleting it | cancelled flow cannot store | GREEN |
| Pending code removal, gateway/http/github-connect-surface.ts:129 | Keep stale code | cancelled flow cannot store | GREEN |
| Stale successful poll, app/app/integrations.tsx:196 | Apply every result | stale successful or failed poll | GREEN |
| Stale failed poll, app/app/integrations.tsx:198 | Remove revision refusal | stale successful or failed poll | GREEN |
| Disconnect completion revision, app/app/integrations.tsx:269 | Omit final revision increment | poll started during disconnect | GREEN |
| Disconnect availability, app/app/integrations.tsx:260 | Invert client availability condition | removes a connected credential | GREEN |
| DELETE reply validation, app/lib/github-connect-client.ts:119 | Disable protocol check | malformed success or failed request | GREEN |
| Rendered disconnect action, app/app/integrations.tsx:265 | Send GET instead of DELETE | removes a connected credential | GREEN |

### Validation

Focused backend tests: 39 passed across `gateway/http/__tests__/github-disconnect.test.ts`, `gateway/http/__tests__/github-connect-surface.test.ts`, `github/__tests__/credential.test.ts`, and `github/connect.test.ts`. Rendered UI: 20 passed in `app/__tests__/github-connect-reachable.test.tsx`. The whole test suite was not run.

`bash scripts/ci/typecheck-all.sh` checked 51 configs and failed. Introduced type errors were corrected, then the affected checks rerun. Remaining gateway diagnostics exactly match a run with all build changes temporarily replaced by HEAD: `gateway/transcription/__tests__/whisper-install.test.ts:186` and `onboarding/history-import/__tests__/zip-writer.ts:10`. App's normal `bun run typecheck` fails implicit `@types` discovery both with and without this change; restricting discovery to local type roots exposes the same existing unused directive at `app/__tests__/support/mount.tsx:17`. The matrix also reported `logger/__tests__/fire-and-forget.test.ts:301`. These files and assertions were not changed. Full matrix green cannot be claimed in this dependency environment.

Final `bash scripts/ci/lint.sh` passed all gates. `bunx tsc --noEmit -p open/tsconfig.json` passed. Root typecheck reports the three existing diagnostic locations listed above. An attempted GitHub package-specific check used a nonexistent config path; the root and Open checks cover its imported production modules instead.

The tree leak gate returned INCOMPLETE: zero findings in executed rules, but the private PII denylist and message-denylist rules could not run. This is not a clean purity result.
