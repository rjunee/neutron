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

The focused store, HTTP, validator, and client run passed 157 tests. Gateway, runtime, and Open TypeScript projects pass individually. The repository matrix reports the pre-existing app ambient-type failure; the first run also exposed merge adaptations, which were corrected before the individual green checks.

The PTY integration file cannot bind its loopback reply sink in this sandbox; its pure startup-bound test passes, while socket-dependent cases report the bind refusal. This is recorded as an environment limitation, not converted into skipped or weakened assertions.

### Deliberately not changed

No shell is introduced: the saved executable and arguments remain structured. No alternate execution path or feature flag was added. Secret values are not added to metadata, prompts, logs, or responses. The frozen `docs/AS_BUILT.md` was not changed.
