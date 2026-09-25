## 2026-09-25 — The liveness census knows the REPL's own MCP services by spawn provenance, not argv

Refs #1226 (not closed by this change); a dependency of the #1309 card, built on main without
touching that PR.

**Root cause.** The project liveness census (`gateway/project-liveness-census.ts`) counted every
descendant of the parent Claude REPL as a busy shell except a DIRECT child whose `/proc/<pid>/cmdline`
satisfied an injected predicate, and `open/wiring/project-liveness.ts` bound that predicate to "argv
names the dev-channel or tools-bridge script". Owner-installed MCP servers had no exemption at all, so
any owner with one installed could never read idle, and credential handoff could never retire the old
Chat. The common installs (`npx -y pkg`, `uvx pkg`) start the real server as a GRANDCHILD, which no
direct-child rule reaches. Matching the configured command and args instead (the #1309 attempt) was
rejected in review: a foreign process can run the exact configured argv without being the service
this parent spawned.

**The design.** Provenance is established where the services are configured to launch.
`runtime/mcp-servers.ts` owns `OWN_SERVICE_PROVENANCE_ENV` (`NEUTRON_REPL_SERVICE_PROVENANCE`); the
spawn (`runtime/adapters/claude-code/persistent/spawn.ts`) writes it, valued with the parent's
`childGeneration`, into the `env` block of EVERY `mcpServers` entry of the per-session `--mcp-config`
— the dev channel, the tools bridge and each owner server, the marker last so no owner-declared value
can win. It is never put in the REPL's own environment: the spawn deletes any inherited copy from
`childEnv`, so a process the agent starts through its Bash tool does not carry it. The owner
validator refuses the name as an env key (reserved by Neutron's own MCP plumbing). The census's
`ProcWalkDeps.isOwnService(argv)` seam is DELETED and replaced by `ownService: { env, value }`: every
descendant, direct or not, is judged by its own `/proc/<pid>/environ` — own only when the FIRST
`env=` entry (getenv semantics) equals `value`. An absent, mismatched, duplicated-later or unreadable
marker, an empty `value`, or no `ownService` at all exempts nothing; the process is counted as a shell
by its `comm`. An own service must still prove its own descendants absent, and each of those is
judged by its own environ, so work a service starts with a cleared or different environment is still
a shell. `ProjectLivenessProbes.descendants` now takes the observed parent (`pid`, `childGeneration`),
and the Open wiring binds `ownService` to that parent's generation. There is ONE rule for built-in
and owner servers; the argv rule is gone, not kept beside it. Reasons remain comm names only.

**Why `childGeneration` is the spawn record.** It is minted once per child at spawn
(`randomUUID()`), persisted as the registry row's `child_generation`, restored on adoption, and
already carried to the census as `ParentObservation.childGeneration` from the exact-identity pool
read. A marker from a previous generation of the same project therefore does not match. The value is
not a secret: the sink credential is an HMAC of it under the instance root.

**Readability evidence.** `claude` hands an entry's `env` block to the stdio server it starts (a live
dev-channel server's environ carries the block's SINK_PORT/SESSION_ID/CHANNEL_NAME), a wrapper's
children inherit it, and `/proc/<pid>/environ` is readable for same-uid processes under yama
`ptrace_scope=1`. A process whose environ cannot be read is not exempted.

**Consuming tests.** `open/__tests__/project-liveness-wiring.test.ts` (new) drives the real
`buildProjectLiveness` probes over the real module-level pool state (`supervisedBySessionKey`,
`pool`, `childByKey`) with a real process standing in for the REPL: a marked `sh -c 'sleep 30 & wait'`
wrapper plus its grandchild reads idle (POSITIVE); the identical argv without the marker, and with a
stale generation, reads busy naming `sh, sleep` (NEGATIVE CONTROLS); a Bash-tool-style `sleep` beside
marked services reads busy naming only `sleep`; an empty parent generation exempts nothing; and the
composed app's `composition.project_liveness` gives the same idle/busy pair. The fake-proc walk cases
(a)-(g) and a real-process twin are in `gateway/project-liveness-census.test.ts`;
`gateway/project-generation-replacement.test.ts` now gates replacement through the environ marker;
`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts` pins the marker on all
three entries with the session's `childGeneration`, its absence from the REPL env (even when the
gateway inherited one), and that an owner-supplied value is overwritten;
`runtime/__tests__/mcp-servers.test.ts` pins the validator refusal.

**Mutation proofs (each mutant compiles and runs).** M1, exempt without provenance (the environ
comparison replaced by `own = true`): the wiring file goes 2 pass / 4 fail (both NEGATIVE CONTROLS,
the Bash-tool case and the composed case), the census file 32/5 (cases b, c, d, e and the real-process
twin), the replacement file 42/1 (`shell`); positives stay green. An argv-match variant (own when the
cmdline contains `sleep`) fails the same four wiring cases. M2, never exempt (`&& false` on the
comparison): the wiring file goes 3/3 (POSITIVE, Bash-tool, composed), the census file 32/5 (a, b, f,
g and the real-process twin), the replacement file 37/6 (every mode expected idle). The control file
`runtime/__tests__/mcp-servers.test.ts` stays 33/0 under both.

**Gates.** `tsc -p tsconfig.json` 0 errors; `tsc -p trident/tsconfig.json` 0 errors;
`scripts/ci/typecheck-all.sh` 50 of 51 tsconfigs pass — `app/tsconfig.json` fails with TS2688 on
the implicit `@types` library identically on the base without this diff (a worktree install
artifact; no `app/` file is touched). Stage-1 file-scoped tests green: census 37/37, replacement
43/43, mcp-servers 33/33, owner-mcp-servers 35/35, the new wiring file 6/6. The full host suite and
CI are host-owned.

**Out of scope.** The Codex adapter's owner MCP path
(`runtime/adapters/codex-cli/persistent/durable-owner-mcp.ts`) is not stamped: the census reads
`cc-agent-*` Claude parents only (`live-project-sessions.ts`). A same-uid process that deliberately
copies the marker out of a service's environ into a command it starts is not distinguished; the
marker proves spawn lineage, not intent.
