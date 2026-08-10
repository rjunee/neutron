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

**Review round 2 found that pairing test insufficient, and it was.** "Every field appears"
is necessary and not sufficient: the first draft joined the command and its arguments with
spaces, so `{command:'/usr/local/bin/example mcp'}` and
`{command:'/usr/local/bin/example', args:['mcp']}` — two different programs, two different
grant hashes — both rendered `/usr/local/bin/example mcp`, and each satisfied "contains
every field". The owner could read one grant and approve the other.

The prompt now gives the program and EACH argument its own line, numbered in argv order,
every value wrapped in `⟦…⟧` so leading and trailing spaces are visible too. And the test
asserts the property that actually matters: **two specs that hash differently never render
the same**, over adversarial pairs (argv-boundary confusion, whitespace, arg order, an
empty arg). Both clients' row summaries render one line per argv entry for the same
reason — the summary above the prompt must not be less honest than the prompt.

The label on an approved row was also overstating. It read "Approved and running with your
assistant", which is wrong twice: nothing runs while the assistant is idle (the config is
read at session start), and the servers reach the CLAUDE-backed session only — a project
pointed at another model provider takes the non-Anthropic branch in
`gateway/wiring/build-llm-call-substrate.ts`, which has no MCP client to hand a stdio
subprocess to. It now reads "Approved — your assistant starts it with its next session",
the Settings copy carries the Claude-session caveat, and a parity test pins the word
"running" OUT of every label on both clients. Extending the OpenAI path to attach MCP
servers is a feature, not a wiring fix; the honest move was to stop claiming it.

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

## What review round 2 changed

Eight findings, each a real hole rather than a style note. Recorded here because the
reasoning is the durable part.

**The decision did not name what it was deciding about.** `POST /decision` carried
`{name, decision}`, and the store bound the press to whatever spec was installed AT THAT
MOMENT. So the grant hash — the whole mechanism — was enforced on every path except the one
the owner actually uses: edit the server from the phone while the browser tab still shows
the old prompt, press Approve there, and the old press approved the new command sight
unseen. The decision now carries `grant_hash`, taken from the row that rendered the prompt,
and a mismatch is refused with the current list attached so the client re-renders the
prompt he now has to read. Both clients send it; the 409 body carries `servers` and both
apply it.

**Deny-then-approve needed two presses and reported a conflict for the first.** A denied
row failed the pending+hash match, so the follow-up approve minted a fresh request and
returned `ok:false` → 409, and the surface dropped the payload. Now, GIVEN A MATCHING HASH,
the decision is applied whether or not a pending row is sitting there — a fresh grant is
opened and resolved in the same call. Safe precisely because the hash matched: the press is
provably about the spec that was on screen. This needed `ApprovalManager.openApproval`, the
observable half of `requestApproval` (which returns a promise resolving only when the owner
answers, so a caller that must not block cannot know when the row exists — and the read
side is synchronous, bypassing the db mutex the INSERT goes through).

**Uninstalling did not revoke.** `remove()` cancelled pending prompts and left approved
rows as an audit trail, reasoning that an uninstalled server is not in the installed list
anyway. True until it is reinstalled: `approvalStateFor` matches on the grant hash alone,
so a byte-identical reinstall re-matched the old approval and the server came back WIRED,
never shown to the owner a second time. `remove()` now calls
`ApprovalManager.revokeApproved`, transitioning approved rows to `expired` — true (the
grant has lapsed), no migration needed, and the row survives with its `args_json` and
decider intact, so the trail still records that he approved that command. Editing still
leaves the old row alone; editing is curating, uninstalling is ending.

**The web card's buttons could be off-screen.** The row reused `.cset-cred-row`, a
single-line `display:flex` with no wrap, and stacked six blocks in it — so Approve/Deny sat
past the right edge behind an unshrinkable `<pre>`. Rendered, correct, and unreachable;
`happy-dom` lays nothing out, so every existing assertion passed. The fix is structural, a
dedicated `.cset-mcp-row` column with per-block overflow containers, and it is checked
against the real stylesheet: the row must not use the single-line class, `.cset-mcp-row`
must declare `flex-direction: column`, the argv and grant blocks must own their
`overflow-x`, the action row must wrap, and every emitted class must exist in
`landing/chat-react.html`.

**Two writers could lose each other.** `install`/`remove` read the whole list, do async
secret work, then rewrite the whole list — so the web tab and the phone installing at the
same time meant the second write was computed from a list that no longer existed, and one
server silently vanished. Both now run inside a promise chain and re-read the list inside
it. The chain advances with a promise that cannot reject, so one failed install does not
poison the writes behind it. The write ORDER also changed, to spec-then-secrets: a crash
in the middle now leaves a new spec that is unapproved AND missing its secrets (two
independent reasons it is not wired), where secrets-first left the OLD, still-APPROVED
command paired with the NEW secrets.

**A failed spawn stranded plaintext secrets in `tmpdir()`.** The MCP config carries the
dev-channel token and every installed server's env VALUES, and cleanup is owned by the
child-exit handler — which does not exist until there IS a child. A throw from
`buildSettings`, trust-seeding or the spawn itself left the file behind for the life of the
box. Each writer and the spawn are now wrapped so a throw removes the config directory
first. Separately, `unlinkSessionConfigs` only ever unlinked FILES, so every session left
an empty 0700 directory in `tmpdir()` forever; it now removes the directory too.

**A third-party handshake could wedge the owner's live chat.** `MCP_CONNECTION_NONBLOCKING
=false` makes `claude` AWAIT the MCP handshake before accepting input, which was safe while
the config held only our own two `bun` scripts. An owner-installed program that accepts a
connection and never completes `initialize` would hold that wait open inside the post-spawn
assertion's 30 s ready budget, on the PRIMARY conversational REPL, and present as
`channel-wedged`. The load stays blocking — the dev-channel bind guarantee is unchanged —
but is now BOUNDED by `MCP_TIMEOUT=10000` whenever an installed server is wired.
`MCP_TIMEOUT` was verified present in the CLI's env-var table (2.1.223, alongside
`MCP_CONNECTION_NONBLOCKING` itself, which served as the control for the check). A spawn
with no installed servers sets nothing, so its startup behaviour is untouched.

**Two smaller ones, both about silently changing what the owner typed.**
`splitCommandLine` treated a quote ANYWHERE as opening a quoted run, so
`/srv/it's/example-mcp` became `/srv/its/example-mcp` — a different path, accepted
silently, then faithfully described by a prompt for a command he never wrote. A quote now
only quotes at the start of a segment. And both clients dropped a non-empty env line with
no `=`, so a mistyped `EXAMPLE_API_KEY sk-…` installed a server with no variables; since
the reply lists only the names that saved, the absent one read as a display quirk rather
than the reason the server would never start. `parseEnvLines` is now a shared (twinned)
helper that REPORTS every bad line, both forms refuse to save, and it is covered by the
cross-client parity gate. The validator also gained an aggregate env cap: two
max-length values each passed the per-value check and then blew the credential store's
8192-byte token cap server-side, turning a validation problem into a thrown error.

Finally, `getOrSpawnSession` now reads the pool BEFORE its first `await`. The
installed-server resolver is async, and resolving it first meant two concurrent dispatches
on one key could both miss the in-flight promise and spawn two `claude` children on one
transcript. No double spawn was reproducible today (the resolver's read happens to settle
in a microtask), but the await-free window is what the dedupe rests on, and
`open/composer.ts` documents a real second concurrent producer.

One round-2 finding is NOT addressed here, deliberately: the panel was incomplete because
one cross-model reviewer's call failed. That is a process gap, not a code defect, and
nothing in this diff can close it.

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

Round 2 added ten more, same discipline — broken, confirmed failing, restored
byte-identical:

| Mutant | Caught by |
| --- | --- |
| `grant_hash` check dropped from `decide` | the stale-hash and no-hash store tests |
| `remove()` stops revoking approved grants | the uninstall-revokes test |
| write serialization removed (`serialize` runs `body()` directly) | both concurrent-write tests |
| per-argument lines dropped, argv space-joined | the hash-distinct-implies-render-distinct property, plus 2 |
| `MCP_TIMEOUT` bound removed | the bounded-startup test |
| failure-path config-directory unlink removed | the failed-spawn-strands-nothing test |
| config DIRECTORY left behind on teardown | the secrets-are-gone test |
| quote-anywhere restored in `splitCommandLine` | 4 parity cases + the apostrophe value test |
| malformed env line silently dropped again | 3 parity cases + 2 behaviour tests |
| aggregate env cap removed | the aggregate-cap validator test |
| approved row claims "running" again | the no-label-claims-running parity test |
| web card back on `.cset-cred-row` | the layout-contract test |

One mutant SURVIVED on the first attempt and is worth recording: joining only the
`command` line with its args left the numbered per-arg lines in place, so the two specs
still rendered differently and the property held. The mutant was wrong, not the test — the
guard is the per-argument rendering, and mutating THAT failed three tests. A survived
mutant is a question about where the guard actually lives, not automatically a gap.

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
