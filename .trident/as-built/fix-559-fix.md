## Issue 559 — owner-installable MCP servers

### What changed

The settings surfaces now create, list, decide, and remove owner-defined MCP server commands through the authenticated app route (`gateway/http/app-mcp-servers-surface.ts:59`, `gateway/http/app-mcp-servers-surface.ts:76`). Definitions are persisted separately from encrypted environment values, and only definitions with an exact matching approved grant are resolved for execution (`gateway/mcp-servers/store.ts:704`, `gateway/mcp-servers/store.ts:806`).

The grant prompt renders the executable and every argument as separate bounded fields, lists only environment-variable names, and explains the callable namespace (`runtime/mcp-servers.ts:455`, `runtime/mcp-servers.ts:462`, `runtime/mcp-servers.ts:476`, `runtime/mcp-servers.ts:481`). The spawn config adds resolved servers only behind the owner-facing bridge opt-in (`runtime/adapters/claude-code/persistent/spawn.ts:223`, `runtime/adapters/claude-code/persistent/spawn.ts:235`).

### Decisions

Installation and authorization remain separate acts. The exact grant identity includes server name, executable, ordered arguments, and variable names; secret-value rotation keeps the grant but changes the warm-session fingerprint so the new value reaches a new child. Missing, stale, malformed, or unreadable state refuses execution. Approval outcomes join the existing `tool_approvals` vocabulary; unknown values fall through to `unapproved` (`gateway/mcp-servers/store.ts:806`, `gateway/mcp-servers/store.ts:817`).

The invariant is maintained continuously at resolution and warm reuse: the store rechecks the exact hash before returning a server (`gateway/mcp-servers/store.ts:704`, `gateway/mcp-servers/store.ts:813`), and the pool fingerprints the resolved surface before reuse (`runtime/mcp-servers.ts:499`). Revocation also retires the warm process surface, so enforcement does not depend on the removed subprocess cooperating.

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Exact grant hash at `gateway/mcp-servers/store.ts:813` | Replaced the hash predicate with an unconditional match; printed line 813 | `approval cannot be minted by writing a row for a DIFFERENT hash` exposed the unauthorized server | Same named test passed after restoring the predicate |

The reviewed lineage's additional guard mutations are retained in `docs/as-built/2026-08-09-installable-mcp-servers.md`; the fresh mutation above verifies the central exact-command boundary against this rebased tree.

### Verification

The focused store, HTTP, validator, client, and production-composition run passed 162 tests. The composition fixture now sends a real owner chat request instead of a reminder because the current reminder path uses the background substrate; it still proves the live-chat resolver is present and bound (`open/__tests__/open-mcp-servers-wiring.test.ts:195`). Gateway, runtime, and Open TypeScript projects pass individually. The repository matrix reports the pre-existing app ambient-type failure; the first run also exposed merge adaptations, which were corrected before the individual green checks.

The PTY integration file cannot bind its loopback reply sink in this sandbox; its pure startup-bound test passes, while socket-dependent cases report the bind refusal. This is recorded as an environment limitation, not converted into skipped or weakened assertions.

### Deliberately not changed

No shell is introduced: the saved executable and arguments remain structured. No alternate execution path or feature flag was added. Secret values are not added to metadata, prompts, logs, or responses. The frozen `docs/AS_BUILT.md` was not changed.

### Rescue round — what the rebase dropped, and the divisor it left wrong

Four CI failures and one reviewed blocker, none of them in main.

**The whole `owner-mcp-servers` file was failing on a 5 s `no-channel-ready`.** Three
independent causes. Its fake `PtyHost` presented the instance ROOT token from
`getReplSinkInfo()`, but the sink authorizes credential to session (`pool-state.ts:522`)
and a child carries `HMAC(root, childGeneration)` — every POST was a 401, measured by
logging the response status rather than inferred; the fixture now reads
`bakedChildSinkInfo(argv)` like every sibling fixture in the directory. `pendingSpawns`
and `committedDispatches` were declared in `pool-state.ts` and read by the evictor while
NOTHING wrote them: the rebase carried the declarations and the reads but dropped the
writer hunks in `spawn.ts` and `pool.ts`, so both busy signals were permanently false and
a revocation fell through to awaiting an unresolved spawn. And `unlinkSessionConfigs`
removed the 0600 files but never the 0700 directory holding them, which the security
tests assert and the system overview already claimed.

**The blocker: `MCP_TIMEOUT` was divided by the owner's count.** `claude` applies the
variable to every entry in `--mcp-config`, which always also holds the reply sink and
(when attached) the tools bridge. Two installed servers were handed 20 s / 2 = 10 s each
across FOUR configured servers — 40 s of serial worst case against a 30 s `readyBudgetMs`
— and even one server sat exactly on the limit at 3 x 10 s. The divisor is now
`Object.keys(mcpServers).length`, the exact object about to be serialised, so it cannot
drift if a third built-in is ever added. `MCP_SERVERS_MAX` is re-derived as
budget / floor less the built-ins and drops 10 to 8, by the same reasoning that took it
24 to 10: the budget is a share of the ready window on the primary conversational REPL,
and a shorter floor fails healthy servers. The two client fixtures advertising the cap
follow it down.

The test that was supposed to see this admitted in its own comment that it could not: it
multiplied the per-server bound by the OWNER cardinality. Both spawn-level assertions now
count the entries in the config file as written, and name the built-ins rather than only
counting them, so two extra owner servers cannot satisfy them.

### Rescue-round mutation table

| Guard | Mutation | Red |
|---|---|---|
| `pendingSpawns.set` (`spawn.ts`) | Deleted the set | `retires a revoked child that NO DISPATCH is waiting on` — the evictor awaits the gated spawn and dies on `no-channel-ready` |
| `committedDispatches` increment (`pool.ts`) | Counted for `ephemeral` only | `spares the child of a dispatch parked BEFORE its turn slot` — `evicted=1`, the committed turn's child killed |
| `committedDispatches` release (`pool.ts`) | Never released | `TERMINATES a warm IDLE child` — `poisoned=1` where it must evict |
| `rmdirSync` (`repl-session.ts`) | Deleted the call | `the config — SECRETS AND ALL — is gone once the session is torn down` |
| `MCP_TIMEOUT` divisor (`spawn.ts`) | Back to `wiredExtraNames.length` | both spawn-level `MCP_TIMEOUT` tests |
| `MCP_SERVERS_MAX` | Back to 10 | `Expected: 20000, Received: 24000` on the derivation |
| Budget / flat-max pair | 20 s to 45 s with a matching floor | `Expected: < 30000, Received: 45000` — proving the ready-window line is armed and not implied by its neighbours |

### Rescue-round verification

`owner-mcp-servers.test.ts` 33/33; the migration snapshot and the 125-repair ledger 4/4
each; the identity-env registry 21/21; the store, HTTP surface and validator suites
110/110; the two client suites green when run in separate processes (running both in one
bun process double-registers happy-dom, which is a harness limit, not a failure of
either). Typecheck 50/51 — `app/tsconfig.json` reports `TS2688 Cannot find type
definition file for '@types'` both with and without this branch's one-line fixture edit,
the same pre-existing ambient-type failure recorded above. Lint green.

Not proven: the full suite was not run (it spawns real REPLs into the operator's live
terminal session), so this reports the files named above and the gates, not a whole-tree
green.
