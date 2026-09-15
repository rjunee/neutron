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

### 2026-09-15 — Config lifecycle cleanup follow-up

The three reported paths share `unlinkSessionConfigs`: shutdown calls it at `runtime/adapters/claude-code/persistent/pool.ts:1536`, child teardown at `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:144`, and failed construction now reaches it through the spawn's `finally` at `runtime/adapters/claude-code/persistent/spawn.ts:976`.

Before changing production code, socket-free lifecycle reproductions printed the following actual config paths (shown relative to the temporary root here), their existence after cleanup, and the responsible owner. The file assertion and directory assertion are separate (`runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:37`).

| Path | Captured config | File exists afterwards | Directory exists afterwards | Owner |
| --- | --- | --- | --- | --- |
| Clean shutdown | `neutron-repl-cleanup-7V2uA9/session-mcp.json` | false | true | pool shutdown → shared cleanup |
| Child teardown | `neutron-repl-cleanup-jglJUX/session-mcp.json` | false | true | child exit → shared cleanup |
| Failed host spawn | `neutron-repl-neutron-726386fa57f5f1696a605cd379c77037/session-mcp.json` | false | true | failed spawn → shared cleanup |

This reproduction established retained empty directories, not retained plaintext on these three paths. It does not claim to reproduce the historical CI filesystem state. The original assertions also require directory removal (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:521`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:548`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:705`). Their security assertions remain, with explicit config-path diagnostics added. The failed-spawn test now requires the host's specific error and a captured secret-bearing config, preventing a socket bind failure from satisfying a generic rejection (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:535`, `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:543`).

### Implementation and error vocabulary

The shared helper removes each file, then removes its validated empty directory with non-recursive `rmdirSync` (`runtime/adapters/claude-code/persistent/repl-session.ts:721`, `runtime/adapters/claude-code/persistent/repl-session.ts:730`). It continues attempting the other paths after a failure, accepts only ENOENT as absence, and logs each failed path before throwing (`runtime/adapters/claude-code/persistent/repl-session.ts:695`, `runtime/adapters/claude-code/persistent/repl-session.ts:723`, `runtime/adapters/claude-code/persistent/repl-session.ts:732`, `runtime/adapters/claude-code/persistent/repl-session.ts:738`). The log is necessary because shutdown has an outer catch (`runtime/adapters/claude-code/persistent/pool.ts:1537`); removal failures must remain visible even there. Existing containment refusals still report the retained credential (`runtime/adapters/claude-code/persistent/repl-session.ts:710`). Non-recursive removal preserves unexpected directory contents; its failure is explicit rather than silently accepted.

Cleanup errors join the existing `SpawnConfigurationError` vocabulary, with an aggregate cause containing the individual filesystem failures (`runtime/adapters/claude-code/persistent/repl-session.ts:739`). This follows the existing local config-read error at `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:116`, checked against its actual disposition: the class stamps `spawn_configuration` (`runtime/adapters/claude-code/persistent/spawn-configuration-error.ts:5`), which is non-retryable (`runtime/errors.ts:106`). An ordinary unstamped error would instead fall through to `undefined` (`runtime/adapters/claude-code/persistent/classify-spawn-error.ts:73`) and become retryable (`runtime/adapters/claude-code/persistent/pool.ts:459`). The test verifies the selected class on a real removal failure (`runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:112`).

Spawn now records every possible config path before the first write (`runtime/adapters/claude-code/persistent/spawn.ts:178`). A `finally` maintains ownership until the child-exit handler is wired (`runtime/adapters/claude-code/persistent/spawn.ts:623`, `runtime/adapters/claude-code/persistent/spawn.ts:976`). This also protects construction failures before host spawn, where the previous host-spawn catch could not run. The additional fixture faults settings construction after verifying the on-disk MCP secret (`runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:69`). Cleanup therefore does not depend on the failed child starting, posting readiness, or emitting an exit event. Successful-child cleanup remains with the existing lifecycle owner.

### Mutation evidence

Every row printed the actual edited source line, ran the selected test to a nonzero exit, restored the source, and reran to exit zero. The three-path rows use the socket-free lifecycle tests, not a claim that the original socket tests ran successfully.

| Guard and landed line | Mutation | Red evidence | Restored |
| --- | --- | --- | --- |
| Shared cleanup, `runtime/adapters/claude-code/persistent/repl-session.ts:659` | immediate return | Shutdown, teardown, failed host spawn: three failures naming stranded `session-mcp.json` paths, no timeout | 3 pass |
| Directory removal, `runtime/adapters/claude-code/persistent/repl-session.ts:730` | remove `rmdirSync(dir)` | Four lifecycle cases report stranded config directories | 4 pass |
| Unlink errors, `runtime/adapters/claude-code/persistent/repl-session.ts:723` | suppress error recording | Exact failed-file diagnostic missing | 1 pass |
| Directory resolution errors, `runtime/adapters/claude-code/persistent/repl-session.ts:695` | suppress error recording | Resolution failure no longer raises | 1 pass |
| Directory removal errors, `runtime/adapters/claude-code/persistent/repl-session.ts:732` | suppress error recording | Nonempty directory failure no longer raises | 1 pass |
| Visible reporting, `runtime/adapters/claude-code/persistent/repl-session.ts:738` | remove stderr report | Failed path absent from captured diagnostics | 1 pass |
| Failure propagation, `runtime/adapters/claude-code/persistent/repl-session.ts:739` | remove throw | No error reaches caller | 1 pass |
| Error classification, `runtime/adapters/claude-code/persistent/repl-session.ts:739` | throw ordinary `Error` | Expected `spawn_configuration`, received `undefined` | 1 pass |
| Pre-child ownership, `runtime/adapters/claude-code/persistent/spawn.ts:976` | remove finally cleanup | Host and settings failures both name stranded config files | 2 pass |

With all cleanup removed, the three printed stranded files were `neutron-repl-cleanup-b8Nhee/session-mcp.json`, `neutron-repl-cleanup-D9aM1Z/session-mcp.json`, and `neutron-repl-neutron-158ecadd521c677834d33cf6280d423a/session-mcp.json` under the temporary root. Each was asserted present before teardown and absent afterwards; no secret value was printed.

The initial resolution-error mutation survived because its fixture never entered the mutated catch: resolving a regular file itself succeeds, and the later unlink guard caught ENOTDIR. The corrected fixture puts another directory component below that regular file and positively asserts that `realpathSync` throws before invoking cleanup (`runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:122`). No assertion was weakened.

### Validation and limits for this follow-up

- `bun test runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts runtime/adapters/claude-code/persistent/__tests__/post-spawn-assertion.test.ts`: 18 pass, zero failures.
- `bun test runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts -t 'fake readiness|stops dividing|is a no-op'`: 6 pass; 31 filtered by the local command.
- The full requested owner-MCP file and `spawn-failure-revokes-credential.test.ts` were attempted together: 6 pass, 34 fail at the forbidden listener bind. Of the owner's 37 runner-enumerated cases, the six executable cases are the rejected-root-credential readiness diagnosis, acknowledgement ordering, both failed-acknowledgement cases, startup division floor, and no-warm-child eviction. The other 31 socket-dependent cases include all three reported security assertions, config wiring, warm reuse, and server eviction. None is claimed green. All three cases in the spawn-failure credential suite require the listener: failed-host credential revocation, and readiness-failure revocation with/without replacement. Their credential assertions remain unverified here.
- `session-config-containment.test.ts` selected positive controls, temp-root refusal, aliased-root cleanup, and scratch cleanup: 6 pass, 15 filtered. An earlier selection also reached the two outside-temp symlink cases; both failed while creating their fixtures under the read-only home directory. Neither is reported as a pass.
- `bash scripts/ci/lint.sh`: all gates pass.
- `bash scripts/ci/typecheck-all.sh`: all 51 projects pass. The runtime project was also checked separately after restoring mutations.

No product/spec decision changed. No new backend, feature flag, alternate secret location, recursive removal, test skip, whole-directory test sweep, or full test runner was introduced. The requested production-cleanup exemplar could not be read at its supplied path in this checkout; the filesystem enumeration `rg --files .trident/as-built | rg 'production-cleanup|fix-559-fix'` returned the known-present current shard as positive control, not the exemplar. This is a checkout observation, not an absence claim about a fetched remote ref; network access was not attempted.

The obsolete cleanup comments were swept with `rg -n 'existing best-effort catch|already gone / never written|spawn itself can throw, and cleanup is owned|finally owns cleanup|Filesystem errors are logged' --glob '*.ts' --glob '*.md' .`. The positive controls found the corrected helper comment and failed-spawn comment; the removed phrases had no remaining hits in that search. This extends the existing single-heading shard as explicitly requested.

### 2026-09-15 — Final teardown round: handoff, failure not reproduced

The starting commit was `5dfe2fc7`. No production or test change is delivered in this round. The requested final-round stop applies: the reported CI failure could not be reproduced with the available socket-free instrument, so this record hands back the measured result instead of adding an unproven fix.

The exact security case awaits `shutdownAllPersistentRepls` before separately asserting file and directory removal (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:516`). Pooled teardown already calls cleanup at `runtime/adapters/claude-code/persistent/pool.ts:1536`, and the walk awaits that teardown at `runtime/adapters/claude-code/persistent/pool.ts:1542`. The child-exit route also calls cleanup at `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:144`. These are observations of this checkout, not an explanation of the failing CI execution.

The existing lifecycle reproduction passed 8/8 before any mutation. Its child teardown is manually wired (`runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:50`), so I also executed the exact owner-MCP security case with a temporary in-process replacement for `Bun.serve` and `fetch`. This preserves the fixture's request handlers but changes transport scheduling; it cannot certify real socket behavior. An `unlinkSync` spy captured the actual caller stack, rather than trusting the fixture's hardcoded owner label at `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:519`.

Measured columns below show paths relative to the temporary directory. Every removal row was printed from the actual unlink spy immediately after removing that file, before the existing post-shutdown assertion:

| Captured config | Exists afterwards | Observed cleanup owner |
| --- | --- | --- |
| `neutron-repl-neutron-bc8706cf9dff0318efee870fd5292b71/session-mcp.json` | false | pool teardown |
| `neutron-repl-neutron-7696200b468a1666b46ed6bfb84b36bc/session-mcp.json` | false | child exit, with pool teardown cleanup removed |
| `neutron-repl-neutron-ec7b57af8f95a8381562b07e8e7c9cb1/session-mcp.json` | false | pool teardown, restored |

Thus this reproduction demonstrates neither a missing call nor cleanup happening after the assertion. The CI discrepancy remains unresolved. The mutation also demonstrates why the exact security case cannot isolate the pooled cleanup call under this substituted transport: child exit performs removal when that call is absent.

### Final-round mutation results

Both mutation locations were printed from the mutated source before running the test and restored in `finally`.

| Existing cleanup | Mutation | Observed result | Restored |
| --- | --- | --- | --- |
| `runtime/adapters/claude-code/persistent/pool.ts:1536` | Replace only the settled pooled teardown call with a comment | Exact owner-MCP security case stayed GREEN under in-process transport; unlink spy identified child exit as the removing owner | GREEN, removing owner returned to pool teardown |
| `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:144` | Replace child-exit cleanup with a comment | Existing socket-free child teardown case RED, explicitly naming surviving `neutron-repl-cleanup-AQjcsV/session-mcp.json`; file and directory both existed | GREEN, file and directory both absent |

The second mutation exercises the existing assertion at `runtime/adapters/claude-code/persistent/__tests__/session-config-cleanup.test.ts:39`. It is not a claim that the reported CI test was made red and fixed. No assertion was loosened, no unlink error was swallowed, and neither previously passing production path was edited.

### Re-running the diagnostic transport

Save the following as a temporary `cleanup-transport.ts` outside the tracked tree, and pass its location to `bun test --preload` with `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts -t 'SECRETS AND ALL'`. The substitute is deliberately a diagnostic, not a replacement for the suite's transport.

```ts
import { spyOn } from 'bun:test'
import * as fs from 'node:fs'
const handlers = new Map<number, Function>()
let nextPort = 45000
spyOn(Bun, 'serve').mockImplementation(((options: any) => {
  const port = options.port || nextPort++
  handlers.set(port, options.fetch)
  return { port, stop() { handlers.delete(port) }, unref() {} }
}) as any)
spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init: any) => {
  const req = new Request(input, init)
  const handler = handlers.get(Number(new URL(req.url).port))
  if (!handler) throw new Error('no in-process handler: ' + req.url)
  return handler(req)
}) as any)
const unlink = fs.unlinkSync
spyOn(fs, 'unlinkSync').mockImplementation((path) => {
  if (String(path).endsWith('/session-mcp.json')) {
    const stack = new Error().stack ?? ''
    const owner = stack.includes('child-exit-wiring.ts') ? 'wireChildExit'
      : stack.includes('pool.ts') ? 'pool teardown' : 'spawn failure'
    unlink(path)
    console.info(JSON.stringify({ config: path, exists: fs.existsSync(path), owner }))
    return
  }
  unlink(path)
})
```

### Final-round validation and limits

- Unmodified socket-free lifecycle file: 8 pass, zero failures. Restored child-teardown mutation selection: 1 pass.
- Unmodified owner-MCP file selected with `-t 'fake readiness|stops dividing|is a no-op'`: 6 pass, 31 filtered out. This runner filter enumerates the six executable cases: root-credential readiness diagnosis, acknowledgement ordering, two acknowledgement refusals, startup division floor, and no-warm-child eviction.
- Exact owner-MCP security case without transport substitution: 1 fail at the reply-sink bind, before reaching teardown (`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:511`). The remaining 31 cases require the socket transport; none is certified here. The requested case passed with the diagnostic substitute, which is explicitly not a socket-suite pass.
- A diagnostic attempt at the owner-MCP file with substituted transport was interrupted after an unrelated dispatch-before-turn-slot eviction assertion failed at `runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts:993`. There is no completed full-file result for that experiment. It reinforces the limit on treating substituted scheduling as equivalent. No whole-directory sweep or full test runner was used.

No product/spec decision, error vocabulary, new invariant, feature flag, or backend changed. The unresolved CI execution needs the orchestrator's direct investigation, per the final-round instruction; this lane stops rather than initiating another repair round.

Final static validation: `bash scripts/ci/lint.sh` passed all gates; `bash scripts/ci/typecheck-all.sh` reported all 51 configurations passing. `git diff --check`, the existing shard's single-heading check, and local checks of added prose for prohibited text passed. This is not a full external leak-gate certification.
