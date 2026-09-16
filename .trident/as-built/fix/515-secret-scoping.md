## 2026-09-16 — Bind Core credential reads to the dispatch project (#515)

### Measured before changing

The filed issue points to the repo spec item. Its old acceptance demanded an
isolation property the owner superseded on 2026-09-16. The cited raw decryption
line is still `auth/secrets-store.ts:485`.

`secrets` is keyed by owner handle, kind and label; the SQL `project_slug` column
is the owner handle, not a real project (`auth/secrets-store.ts:17`,
`auth/secrets-store.ts:230`). `project_credentials` already keys by
`(owner_slug, project_id, service)` (`project-credentials/store.ts:266`). The
empty project id denotes an explicit global row (`project-credentials/store.ts:35`).
Both stores share the AES key (`auth/secrets-store.ts:79`). This is a read-path
change, not re-encryption.

### Change and continuously maintained boundary

The existing production MCP composition binds the dispatch project
(`gateway/composition/build-core-modules.ts:368`, `mcp/server.ts:150`). The
resolver now preserves the distinction between an absent host frame and a bound
unknown id (`gateway/cores/active-project-context.ts:55`). On every credential
resolution it uses the bound identity, refuses unknown, and refuses a conflicting
requested project before either storage or OAuth is read
(`gateway/cores/core-credential-resolver.ts:282`). The existing exact project SQL
predicate remains the row boundary (`project-credentials/store.ts:387`).

Maintenance is synchronous in the gateway resolver, on each call, independent of
the build's cooperation or continued liveness. Async context is installed around
the handler lifetime (`mcp/server.ts:150`); missing production wiring refuses
credentials, while the positive-control wiring test fails
(`gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts:187`,
`gateway/composition/build-core-modules-mcp-active-project.test.ts:167`).
This does not stop same-process code deliberately rebinding context or invoking
host storage APIs directly.

Refusal joins the existing uncredentialed vocabulary: an empty account list,
then `null` for a single credential (`gateway/cores/core-credential-resolver.ts:329`).
The existing lazy accessors also return empty/null on errors
(`gateway/cores/core-credential-resolver.ts:345`,
`gateway/cores/core-credential-resolver.ts:362`). No new error code, logging or
secret-bearing diagnostic is introduced by the guard at lines 287–288.

### Instance-wide exceptions and decisions

Enumerated by reading the resolver policy tables and fallback branch
(`gateway/cores/core-credential-resolver.ts:66`,
`gateway/cores/core-credential-resolver.ts:308`), the global store sentinel
(`project-credentials/store.ts:334`), and host authentication readers:

- An owner explicitly saving any named service with global scope shares that
  row as a default (`project-credentials/store.ts:218`). Custom names are
  included; a row belonging to another real project is not a global default.
- `gmail_compose` and `google_calendar` force global scope. Shared legacy OAuth
  fallback covers those two and `google_workspace`. Project account selection
  still applies (`gateway/cores/core-credential-resolver.ts:222`).
- Host GitHub authentication remains the instance `oauth_token` / `github` row
  (`github/credential.ts:50`, `github/credential.ts:79`). Host Codex seats remain
  `codex` / `codex-acct-<slot>` global rows (`trident/codex-credential.ts:55`,
  `trident/codex-credential.ts:68`, `trident/codex-credential.ts:1179`), and Kimi
  remains a host global lookup (`open/composer.ts:3934`). These are not grants of
  the host store to the Core credential API. Other host store consumers were not
  converted to project APIs by this change.

Unknown identity refuses even shared Core credentials. Consequently General,
cron and direct Core calls without project identity no longer inherit global
credentials. Trusted host calls outside a frame can explicitly name a project.
That follows the unknown-refuses requirement; no privileged unknown fallback was
added. Existing tests expecting that fallback were updated to the new contract.
Google-account fixtures now provide a known project without changing their
account/failure assertions (`gateway/cores/__tests__/google-multi-account.test.ts:236`,
`gateway/cores/__tests__/google-multi-account.test.ts:525`). The OAuth-error test
also binds a project so it still reaches the error
(`gateway/cores/__tests__/core-credential-resolver.test.ts:264`).

### Tests and mutation table

The boundary tests exercise real encrypted rows through MCP, including positive
controls for A and B, a B-only service, conflicting and matching explicit ids,
and unknown identity (`gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts:233`).
The separate raw-key test deliberately decrypts B after A's API refusal
(`gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts:273`).
**This proves API scoping and demonstrates the accepted bypass; it does not prove
cross-project cryptographic isolation.**

All mutations compiled with gateway tsc, then ran the same 8-test boundary file.
The actual mutated source line was printed before each run. Each was restored
immediately; each restoration passed all 8 tests and 31 assertions.

| Guard / actual landing line | Mutation | Mutated pass / fail | Restored pass / fail |
| --- | --- | --- | --- |
| Unknown refusal, resolver:287 | `if (false) return []` | 3 / 5 | 8 / 0 |
| Conflicting request refusal, resolver:288 | `if (false) return []` | 7 / 1 | 8 / 0 |
| Binding authority, resolver:283 | Requested id before frame id in coalescing | 6 / 2 | 8 / 0 |
| Exact row scope, store:387 | `project_id = ?` to `? IS NOT NULL` | 2 / 6 | 8 / 0 |

Here resolver is `gateway/cores/core-credential-resolver.ts`; store is
`project-credentials/store.ts`. The SQL mutation returned B's plaintext to A in
the bypass fixture, establishing reachability with populated ciphertext. The
binding mutation allowed a B override; the unknown mutation returned global
plaintext. These were wrong answers, not compiler failures.

Final targeted run: **95 pass, 0 fail, 490 assertions across 8 files**. Files were
enumerated from resolver imports/call sites, changed context tests, production
MCP composition, and the generated spec index:

- `gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts`
- `gateway/cores/__tests__/core-credential-resolver.test.ts`
- `gateway/cores/__tests__/project-account-selection.test.ts`
- `gateway/cores/__tests__/active-project-context.test.ts`
- `gateway/cores/__tests__/google-multi-account.test.ts`
- `gateway/cores/__tests__/mount-open-cores.test.ts`
- `gateway/composition/build-core-modules-mcp-active-project.test.ts`
- `scripts/__tests__/spec-items-index.test.ts`

Repository lint passed (`bash scripts/ci/lint.sh`). Gateway tsc passed, including
all four compiling mutations. Final `tsc --noEmit -p` checks passed for
`tsconfig.json`, `gateway/tsconfig.json`, `mcp/tsconfig.json`, and
`project-credentials/tsconfig.json`. `git diff --check` passed. The leak gate exited
3: zero findings from executed rules, but the local PII denylist is unavailable.
That is incomplete verification, not a clean leak-gate result; the orchestrator
must run the configured gate before publication.

### Documentation and deliberately excluded work

The spec item now states incidental access prevention and the accepted raw-key
bypass; `SPEC.md` adds the owner decision above existing immutable entries. The
spec index was regenerated. A whole-tree content search for the old unknown/global
claims found stale prose in the system overview and account-selection comment;
those were corrected together with the related tool-state spec item. A repeated
search including the known-present `Unknown refuses` control found the control
at `SPEC.md:151` and resolver:285, and no old matched claims. This is a working-tree
content check, not a claim about a freshly fetched remote ref.

No OS key boundary, crypto format change, migration, key rotation, feature flag,
agent-side publishing change, remote issue edit, push or PR was attempted. The
as-built location follows the lane's explicit instruction over the repository's
usual shard location. Full-suite execution was deliberately excluded.
