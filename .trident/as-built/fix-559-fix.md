## Issue 559 — owner-installable MCP servers

### What changed

The settings surfaces now create, list, decide, and remove owner-defined MCP server commands through the authenticated app route (`gateway/http/app-mcp-servers-surface.ts:59`, `gateway/http/app-mcp-servers-surface.ts:76`). Definitions are persisted separately from encrypted environment values, and only definitions with an exact matching approved grant are resolved for execution (`gateway/mcp-servers/store.ts:704`, `gateway/mcp-servers/store.ts:806`).

The grant prompt renders the executable and every argument as separate bounded fields, lists only environment-variable names, and explains the callable namespace (`runtime/mcp-servers.ts:455`, `runtime/mcp-servers.ts:462`, `runtime/mcp-servers.ts:476`, `runtime/mcp-servers.ts:481`). The spawn config adds resolved servers only behind the owner-facing bridge opt-in (`runtime/adapters/claude-code/persistent/spawn.ts:223`, `runtime/adapters/claude-code/persistent/spawn.ts:235`).

The production wiring regression now observes the live-chat substrate directly: the factory resolves a one-shot promise when it receives `cc-agent-owner`, and the helper awaits that signal plus fixture-turn completion behind a 15-second diagnostic ceiling (`open/__tests__/open-mcp-servers-wiring.test.ts:134`, `open/__tests__/open-mcp-servers-wiring.test.ts:144`, `open/__tests__/open-mcp-servers-wiring.test.ts:220`). The fixture drives the production app chat handler (`open/__tests__/open-mcp-servers-wiring.test.ts:181`), because reminders now compose on the separate background substrate (`open/composer.ts:2959`, `open/composer.ts:2975`); the old 20ms sleep therefore measured neither completion nor live-chat MCP wiring.

### Decisions

Installation and authorization remain separate acts. The exact grant identity includes server name, executable, ordered arguments, and variable names; secret-value rotation keeps the grant but changes the warm-session fingerprint so the new value reaches a new child. Missing, stale, malformed, or unreadable state refuses execution. Approval outcomes join the existing `tool_approvals` vocabulary; unknown values fall through to `unapproved` (`gateway/mcp-servers/store.ts:806`, `gateway/mcp-servers/store.ts:817`).

The invariant is maintained continuously at resolution and warm reuse: the store rechecks the exact hash before returning a server (`gateway/mcp-servers/store.ts:704`, `gateway/mcp-servers/store.ts:813`), and the pool fingerprints the resolved surface before reuse (`runtime/mcp-servers.ts:499`). Revocation also retires the warm process surface, so enforcement does not depend on the removed subprocess cooperating.

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Exact grant hash at `gateway/mcp-servers/store.ts:813` | Replaced the hash predicate with an unconditional match; printed line 813 | `approval cannot be minted by writing a row for a DIFFERENT hash` exposed the unauthorized server | Same named test passed after restoring the predicate |
| Live-chat resolver at `open/wiring/substrates.ts:281` | Removed the `resolveExtraMcpServers` spread; printed the mutated lines 276-286 | `the live-chat substrate CARRIES the resolver` failed at `open/__tests__/open-mcp-servers-wiring.test.ts:259` with `Received: "undefined"`; the capture did not time out | Restored lines 281-283; the focused file passed 5 tests |

The reviewed lineage's additional guard mutations are retained in `docs/as-built/2026-08-09-installable-mcp-servers.md`; the fresh mutation above verifies the central exact-command boundary against this rebased tree.

### Verification

The focused store, HTTP, validator, and client run passed 157 tests. Gateway, runtime, and Open TypeScript projects pass individually. The repository matrix reports the pre-existing app ambient-type failure; the first run also exposed merge adaptations, which were corrected before the individual green checks.

For this follow-up, `bun test open/__tests__/open-mcp-servers-wiring.test.ts` passed 5 tests in 2.07s, `bash scripts/ci/lint.sh` passed every gate, and `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects.

The PTY integration file cannot bind its loopback reply sink in this sandbox; its pure startup-bound test passes, while socket-dependent cases report the bind refusal. This is recorded as an environment limitation, not converted into skipped or weakened assertions.

The merged-forward repair regenerated the schema snapshot from the migration chain. The resulting `instance_metadata` definition contains the MCP column and the later provider columns in one valid definition (`migrations/expected-schema.txt:980`, `migrations/expected-schema.txt:989`). The environment-reader inventory now declares `runtime/mcp-servers.ts` as a conservative regex match (`tests/integration/identity-env-readers-registry.test.ts:242`): its matching code is the generic uppercase env-name validator (`runtime/mcp-servers.ts:138`), while the same targeted read search positively found all three identity reads in `migrations/db-path.ts:45`, `migrations/db-path.ts:47`, and `migrations/db-path.ts:80` and found none in the MCP module.

The credential POST now classifies the service through the store-owned reservation predicate before applying the generic short-token rule (`gateway/http/project-credentials-surface.ts:262`, `gateway/http/project-credentials-surface.ts:266`). This joins the existing `ProjectCredentialValidationError.code` vocabulary: `reserved_service` is already the store refusal (`project-credentials/store.ts:299`, `project-credentials/store.ts:302`) and write-validation codes map to HTTP 400 (`gateway/http/project-credentials-surface.ts:406`). The route test asserts both the code and the unchanged store (`gateway/http/__tests__/project-credentials-surface-scope.test.ts:243`, `gateway/http/__tests__/project-credentials-surface-scope.test.ts:249`).

The requested five-file test command passed 89 tests. `bash scripts/ci/lint.sh` passed every gate, and `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects.

### Merged-forward repair mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Reserved-service classification at `gateway/http/project-credentials-surface.ts:266` | Inverted `isReservedService`; printed the mutated line 266 | Focused POST refusal failed: expected `reserved_service`, received `invalid_token` | Restored line 266; the same focused test passed |

### Deliberately not changed

No shell is introduced: the saved executable and arguments remain structured. No alternate execution path or feature flag was added. Secret values are not added to metadata, prompts, logs, or responses. The frozen `docs/AS_BUILT.md` was not changed.

This follow-up changes only the production wiring fixture and this existing record, enumerated with `git diff --name-only HEAD`. It does not change runtime behavior, the migration ledger, the app settings screen, or product decisions.

The merged-forward repair adds no registry exclusion, does not hand-edit schema structure, and does not weaken the HTTP assertion. No product or specification decision changed. Its three implementation files were enumerated with `git diff --name-only` before this record was updated: `gateway/http/project-credentials-surface.ts`, `migrations/expected-schema.txt`, and `tests/integration/identity-env-readers-registry.test.ts`.

### Readiness follow-up — diagnosis and changes

The socket-free reproduction calls the real sink handler with an isolated root credential, observes HTTP 401, and prints `no-channel-ready`, `elapsedMs=5000`, `budgetMs=5000`, `channelPort=unset`, `childAlive=true` using an injected clock (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:106`). The accepted child credential then passes the same assertion (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:132`). This confirms a credential defect in the old fake, not the proposed scheduling-only explanation: authorization indexes child credentials and refuses an unmatched root credential (`runtime/adapters/claude-code/persistent/pool-state.ts:522`). It does not reproduce the historical CI run or measure its wall-clock expiry.

The fake now reads the child credential from the actual spawn config (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:209`). The exemplar was checked against this property: `runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts:50` uses `bakedChildSinkInfo`, whose implementation reads `SINK_TOKEN` and `SINK_PORT` from config (`runtime/adapters/claude-code/persistent/repl-sink.ts:161`). The fake awaits the test's readiness gate and both successful HTTP acknowledgements before returning the child (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:96`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:244`). Sink registration precedes host spawn (`runtime/adapters/claude-code/persistent/spawn.ts:506`), so this ordering can complete without waiting for the returned child. This awaited sequence continuously maintains fixture readiness; it does not depend on a detached background task finishing before a timer.

Rejected acknowledgements become fixture promise rejections naming PID, endpoint and status (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:102`); the rejection tests consume that existing test vocabulary with `rejects.toThrow` (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:168`). The host closes its fake server on handshake failure (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:245`). Production expiry details now include elapsed time, budget and the observed stage state (`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:120`, `runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:135`, `runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:164`). These retain the existing `SpawnAssertionFailureReason` values and their explicit formatter cases; they introduce no unclassified runtime outcome (`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:179`).

ADDED, REVOKED and ROTATED retain their config/allow-list assertions and additionally assert that the original child exited, with `stale child pid=... survived the server-set change` as the failure label (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:791`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:809`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:830`).

### Readiness mutation table

Each executed mutation printed the changed source line, failed by assertion, then passed the same named test after restoration.

| Guard / evidence | Mutation | Red | Restored green |
|---|---|---|---|
| Ready acknowledgement, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:102` | Ignore rejection specifically for `/channel-ready` | Ready refusal test resolved instead of rejecting | 1 pass |
| Bound acknowledgement, same line | Ignore rejection specifically for `/channel-bound`; ready response remains successful so the second guard is reached | Bound refusal test resolved instead of rejecting | 1 pass |
| Test readiness gate, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:96` | Remove the gate await | Expected no posts; received `/channel-ready` | 1 pass |
| Ready elapsed detail, `runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:120` | Report elapsed zero | Expected 1200; received zero | 1 pass |
| Health elapsed detail, `runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:135` | Report elapsed zero | Expected 1200; received zero | 1 pass |
| Bound elapsed detail, `runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:164` | Report elapsed zero | Expected 1200; received zero | 1 pass |
| Warm eviction, `runtime/adapters/claude-code/persistent/spawn.ts:1567` | Requested mutation: force MCP freshness true, retaining the stale warm child | **Not executed:** socket-dependent ADDED / REVOKED / ROTATED cases cannot run in this sandbox | **Not verified**; the new PID assertions are not claimed as demonstrated mutation coverage |

### Readiness verification and limits

`bun test runtime/adapters/claude-code/persistent/__tests__/post-spawn-assertion.test.ts` passed 10 tests. `bun test runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts -t 'fake readiness|stops dividing|is a no-op'` passed 6 cases; 31 were filtered by that explicit selection. Filtering is only the local command, not a skip added to the suite. The acknowledgement tests use controllable promises; the expiry tests use an injected clock.

The socket-dependent cases remain unrun because the supplied sandbox restriction refuses loopback binds. In particular, the reported failures are ADDED (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:778`), REVOKED (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:798`), ROTATED (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:816`), SAME installed set REUSES (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:765`), and the abbreviated report for `an approved server reaches BOTH the config and the allow-list` (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:338`). The report does not identify which child test in that last group failed. Enumerating its `it` declarations gives six cases, all unrun here: exact command/args/env (:339), own namespace grant (:355), dev-channel and bridge retention (:370), no bridge tools (:385), no resolved servers (:399), and built-in-name collision (:411), in that same file. No integration pass or stale-child mutation result is claimed.

`bash scripts/ci/lint.sh` passed (exit 0). `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects (exit 0). `git diff --check` passed. The shard still has exactly one `## ` heading.

### Readiness scope decisions

The 5000ms ready and health budgets remain (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:290`), as does the 90000ms runner allowance and the reasoning for keeping real spawn headroom (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:64`). No product decision changed. This follow-up does not modify eviction behavior, add a feature flag, change the runner script, or run the whole suite. Its three code/test paths were enumerated with `git diff --name-only` before extending this record. The user explicitly requested extending this existing shard rather than creating another record.

The header correction was swept with `rg -n 'fake spawn takes its full budget|channel is announced immediately|HEADROOM: keep the existing runner allowance' --glob '*.ts' --glob '*.md' .`: the positive control found the revised header at `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:64`; neither removed phrase had another hit in that search scope.
