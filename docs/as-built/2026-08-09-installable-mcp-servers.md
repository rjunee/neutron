# 2026-08-09 — Installable MCP servers

The owner can add an MCP server to his assistant, and the assistant can call its tools.
Before this, the spawned session got exactly two MCP servers, both compiled in — the
dev-channel reply sink and the in-process Neutron tool bridge — and there was no
configuration surface anywhere for a third. The whole published MCP ecosystem was
unreachable from his own instance, which is a cutover-parity blocker rather than a
nicety.

His words: *"it seems like mcp servers should be installable."* Two calls stated and not
objected to, so taken as decided: **instance-wide, not per-project** (one set serves
every project on this box, like the transcription backend and the build-model settings),
and **each server needs approval before its first use**, the way a credential does.

## What the owner sees

Settings → **MCP servers**, on both clients (web `landing/chat-react/SettingsTab.tsx`,
mobile `app/app/mcp-servers.tsx` reached from `app/app/settings.tsx`). A name, a
one-line command, and `NAME=value` environment variables. Adding a server does not
start it: the row lands **pending**, showing the exact request, and a separate
**Approve** press is what permits it. Remove uninstalls.

## Installing is not approving

That separation is the entire security model, because an installed MCP server is a
subprocess started with the owner's permissions and there is nothing underneath him.

- The grant is an ordinary `tool_approvals` row (migration 0004) under
  `mcp-server:<name>`, bound to a SHA-256 over `[name, command, args, sorted env NAMES]`
  — the same content-hash mechanism `reminders/ritual-approval.ts` uses for scheduled
  executors, deliberately not a second approval concept. `approve` resolves through
  `ApprovalManager.respondApproval`, so there is one waiter map and one table.
- **A program cannot widen what it runs after approval.** Change the command, any arg, or
  the set of variable names and the hash moves, the old row stops matching, and the
  server drops out of the spawn until the owner approves the new request. Recomputed on
  every resolve, never cached.
- **Rotating a VALUE does not require re-approval.** What was granted is which program
  runs with which variables set; re-asking on every key rotation would teach him to click
  through prompts. Values are not hash inputs.
- No `policy: 'auto'` path, no pre-approved server, no default when a decision is
  missing or garbled — a malformed decision request is a 400, because defaulting to
  approve would grant a capability from a broken request and defaulting to deny would
  discard an approval he did make.
- An exact revert restores the original approval without a second prompt. Intended, and
  the same behaviour the ritual grants have: he already approved that exact program with
  those exact variables.

## The prompt says exactly what the grant is

`renderMcpServerGrant` (`runtime/mcp-servers.ts`) builds the text from the same fields
the hash covers — the name, the command, every argument, and the variable NAMES, never a
value — and states that approving starts the program on this machine with his
permissions. Both clients render it **verbatim**; neither assembles or summarises it, so
a client cannot describe something other than what the server would run.

This repo shipped the opposite failure a few entries above: an egress approval given for
a capability the code could not exercise (`docs/as-built/2026-08-09-live-agent-web-tools.md`).
A prompt that overstates or understates what it grants spends the credibility the whole
gate rests on, so the test asserts the PAIRING — every field the hash covers appears in
the prompt — rather than the wording.

## Where the three pieces live

| Question | Store |
| --- | --- |
| what is installed | `instance_metadata.mcp_servers` (migration 0120), a JSON array of name/command/args/**env_names** |
| what its secrets are | AES-256-GCM `project_credentials` at global scope, `mcp_env.<name>` |
| what the owner permitted | `tool_approvals` under `mcp-server:<name>` |

`gateway/mcp-servers/store.ts` is the only place that joins them, and
`resolveApproved()` returns a server only when it is installed and still valid, has an
`approved` row matching the hash recomputed from the LIVE spec, and has a stored value
for every variable it declares. That last one is fail-closed on a state that should be
impossible: starting the program with a promised variable unset is not what was
approved, so it is skipped and logged instead.

Keeping values out of the spec is what makes the spec safe to store in a plain metadata
column, return to both clients, render in a prompt, and log. Nothing on the wire, in
`instance_metadata`, or in an approval row carries one; a rejected input echoes a
variable NAME but never a value, because an error body is a log line waiting to happen.

## Reaching the spawn, and the warm-session guard

`runtime/adapters/claude-code/persistent/spawn.ts` merges the approved servers into
`mcpServers` **alongside** the two built-ins and adds each `mcp__<name>` to
`--allowedTools`. Those are two separable links and both are needed: config alone starts
a server whose every tool call then hits a permission prompt no headless REPL can answer.
The tests assert them separately for that reason, and a name colliding with a built-in is
skipped rather than merged — which of the two survived would otherwise depend on merge
order.

**The reuse-guard decision.** `claude` reads `--mcp-config` once at startup, so a warm
child physically cannot learn about a server installed afterwards. `mcpSurfaceFingerprint`
makes the installed set comparable the same way `authFingerprintFor` makes a rotated
credential comparable, and `ReplSession.mcpFingerprint` joins the existing freshness
guards: a change evicts and respawns with `--resume`, so the conversation survives and the
new server is live from that turn. Equal configuration yields an equal fingerprint, so an
unchanged set reuses the warm child and the owner does not pay a cold spawn per message —
the two failure modes here are opposite, both silent, and both mutation-tested. Env VALUES
are hashed in (never logged or persisted) so a rotated secret actually reaches the
subprocess rather than waiting for some unrelated respawn.

**Two independent gates confine this to the owner's own session.** The resolver is wired
onto `cc-agent-*` only (`open/wiring/substrates.ts`), and `spawn.ts` also requires
`enableToolBridge`. The untrusted history-import (`cc-import-*`) and disposable Trident
(`cc-trident-*`) REPLs run `tools: []` default-deny specifically to close a
prompt-injection vector, and a subprocess is strictly more capability than a built-in
tool — so a future wiring mistake on either gate alone cannot open it. The resolver is
not even CALLED on those substrates, so an untrusted spawn never reaches into the
credential store. The MCP config file stays 0600 in its 0700 directory, now that it
carries installed servers' secrets as well as the sink token.

## One ApprovalManager, not two

The composer builds it and hands it to the graph as `approval_manager`;
`build-core-modules` reuses a caller-supplied one exactly as it already does for
`ChannelRouter`. Two instances over one `tool_approvals` table would each hold their own
map of pending decisions and disagree about what is still waiting.

The store reads the manager through a getter and the composer binds its store into a
holder the live-chat substrate was handed at boot, because both are constructed after the
substrate is. An unbound holder answers "no servers installed" forever — an install would
appear to succeed and silently never take effect — which is why
`open/__tests__/open-mcp-servers-wiring.test.ts` boots the REAL composer, installs and
approves through the REAL surface, and then calls the resolver the REAL live-chat
substrate received.

## Mutation log

Each guard broken deliberately, each confirmed to fail a test, each restored
byte-identical:

| Mutant | Caught by |
| --- | --- |
| approval gate removed from `resolveApproved` | 7 failures across the unapproved + re-approval blocks |
| grant hash covers only the name | 3 hash tests + 4 store tests |
| `mcp__<name>` allow-list entry dropped (config kept) | 3 spawn tests |
| config entry dropped (allow-list kept) | 4 spawn tests |
| `enableToolBridge` gate removed from the spawn | all 3 untrusted-substrate tests |
| composer never binds the store holder | the real-composer resolver test |
| `freshMcpServers` dropped from the reuse guard | added / revoked / rotated all stop taking effect |
| fingerprint made non-deterministic | the no-thrash test plus 2 fingerprint tests |

One test was also found to be **passing for the wrong reason** and fixed rather than
kept: the web section's typing helper assigned `.value` directly, which leaves React's
value tracker unchanged so `onChange` never fires — the assertions were reading a request
body that happened to be right. It now goes through the prototype setter. In the same
pass, a "skip if the call 401s" branch in the composer wiring test was deleted after it
turned out to be the branch actually being taken, which had quietly reduced the strongest
assertion in the file to nothing.

## Verified

`bash scripts/ci/typecheck-all.sh` and `bash scripts/ci/lint.sh` pass; the layering gate
reports no new cross-band edge. The new suites:
`runtime/__tests__/mcp-servers.test.ts`,
`gateway/__tests__/mcp-servers-store.test.ts`,
`gateway/__tests__/mcp-servers-client-parity.test.ts`,
`gateway/http/__tests__/app-mcp-servers-surface.test.ts`,
`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts`,
`open/__tests__/open-mcp-servers-wiring.test.ts`,
`landing/chat-react/__tests__/settings-tab-mcp-servers.test.tsx`,
`app/__tests__/mcp-servers-reachable.test.tsx`.
