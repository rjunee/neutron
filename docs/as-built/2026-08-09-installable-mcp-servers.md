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
transcript.

> **Round 3 correction — this paragraph was wrong in both halves.** It originally continued
> "No double spawn was reproducible today (the resolver's read happens to settle in a
> microtask)". A reviewer reproduced it on the first attempt. And moving the `pool.get`
> above the `await` never fixed anything: the invariant is that nothing suspends BETWEEN
> the read and the `pool.set`, which is a property of the whole cold path, not of the
> read's position. See § What review round 3 changed.

One round-2 finding is NOT addressed here, deliberately: the panel was incomplete because
one cross-model reviewer's call failed. That is a process gap, not a code defect, and
nothing in this diff can close it.

## What review round 3 changed

Three blockers, one major, three minor. Two of the three blockers were regressions this
feature introduced into code that was correct before it, which is the more useful half of
what round 3 found.

**The spawn de-duplication window was reopened, and the comment claiming otherwise was the
tell.** Round 2 hoisted `pool.get` above the `await options.resolveExtraMcpServers()` and
wrote a comment saying that "restores the await-free window as an invariant of the code".
It does not. Two concurrent dispatches on one session key collapse onto one spawn only
because NOTHING SUSPENDS between the read and the `pool.set` at the end of the function;
an `await` after the read is exactly as wide a window, because the second caller then
reads a pool the first has not written yet. Both spawn. The fingerprint of ZERO installed
servers is `''`, so this fired on every cold start for every owner, not only for one who
had installed something — and the loser child never entered the pool, so
`shutdownAllPersistentRepls()` could not kill it and it outlived the process holding an
open 0600 MCP config full of plaintext secrets.

The resolve now happens INSIDE the warm-reuse branch, which is the only place its value is
used and which has already awaited `existing` — so a concurrent caller there is looking at
the same warm session rather than at an empty pool, and the cold path is straight-line
from read to set again. Three tests pin it: one spawn for two concurrent cold dispatches,
nothing left in `tmpdir()` after shutdown, and exactly ONE resolver call on a cold start
(two would mean the pre-`pool.set` await is back).

This is the aspirational-docblock failure mode in its purest form. The comment was
confidently specific, described a mode the code never entered, and was written in the same
change that introduced the defect — so it read as design documentation for a guarantee
that did not exist.

**An undecryptable credential row took down the whole surface instead of one server.**
`ProjectCredentialStore.resolve` decrypts INLINE, and AES-256-GCM throws on a malformed
envelope or a failed tag check. That call sat OUTSIDE `readSecrets`' `try`, so one bad
`mcp_env.*` row — a truncated write, a restored backup, a `secrets_key` this box no longer
holds — threw out of `list()` and `resolveApproved()`. That is a 500 on the Settings GET,
a rejection on every chat turn's spawn resolve, and, worst of it, no way to UNINSTALL the
offending server, because the fault was on the read path the uninstall needs. The store's
own header promised to fail closed on exactly this state; an unhandled throw is not a way
to express that promise, and the same class of file already handles a malformed approval
row by returning "no match". The decrypt is now inside the `try`, every failure lands on
the same answer — no secrets — which `resolveApproved` already treats as fail-closed and
already logs, and the server shows in Settings as installed with its secrets missing.
Re-entering the value heals it with no second prompt, since the spec never changed.

**Uninstall dropped the spec before revoking the grant.** Three stores, no transaction
across them, so the order has to be the one whose every partial outcome is safe — and this
was the inverse of the order `install` is reasoned about. A failure after the spec write
left an APPROVED grant for a server that no longer existed, and the owner could not heal
it: the retry re-reads the list, finds nothing, and answers `removed: false` while the live
grant waits in the table for a byte-identical reinstall to re-match it. Now it revokes,
then forgets the secrets, then drops the spec. Every partial outcome leaves the server
unapproved-but-installed: not wired, still visible, and the retry has a target.

**A deny that arrived after an approve reported success and stopped nothing.**
`approvalStateFor` tests `approved` before `denied` — the safe precedence for a read — so
recording a denial ALONGSIDE a live approved row left the server wired while `decide`
answered 200 and the list said "denied". Two clients make this ordinary: the phone
approves, the tab still shows the pending prompt, and the tab's Deny is the only stop
button the owner has. Deny now revokes any approval in force for that server before it
records the denial, and the idempotency check reads the rows AFTER the revoke — otherwise a
repeated deny would short-circuit on its own first denied row while an approval opened in
between stayed live. Approving after a deny still works; that is asserted separately so the
revoke cannot be over-corrected into a permanent block.

**`MCP_TIMEOUT` bounded one server while the budget covered all of them.** The round-2 note
described 10 s as "chosen against the post-spawn assertion's 30 s `readyBudgetMs`", which
compared two quantities that are not comparable: `MCP_TIMEOUT` bounds ONE server's
`initialize`, `readyBudgetMs` bounds the whole spawn. If the CLI's blocking connect group
loads serially — not verified here, so sized for the worse case — four hung servers exhaust
the budget between them with every individual timeout honoured. The bound is now divided
across the servers actually wired, against a stated 20 s share of the ready budget, with a
2 s floor. One or two servers keep exactly the 10 s they had. The floor is where the
honesty has to be explicit and the test says so out loud: past ~10 servers the division
stops, and the serial worst case CAN exceed the budget. A timeout short enough to fit would
fail healthy servers, trading a rare slow spawn for a permanently broken one; the real fix
would be a concurrent load or a larger budget, neither of which a per-server bound supplies.

**The approval prompt could show two different grants identically.** The denylist
enumerated the bidi controls, the zero-widths and the C0 controls and stopped, which left a
whole family of characters that also occupy no width. Measured in a browser against the
prompt's own type styles, three specs differing only by a WORD JOINER rendered to the same
pixel width — so two grants the hash correctly distinguishes were indistinguishable on
screen. No full substitution is possible with these (an invisible can pad a string but
cannot hide a visible character), so this is a legibility hole rather than a spoofing one,
and it still has to close: the promise this prompt makes is that the owner can SEE what he
is approving. Added NEL, SOFT HYPHEN, ARABIC LETTER MARK, MONGOLIAN VOWEL SEPARATOR, LINE
and PARAGRAPH SEPARATOR, WORD JOINER and the invisible math operators, the deprecated
format controls, the interlinear annotation marks, and the TAG block — the last needing the
`u` flag so it can be written as a code point instead of a surrogate pair. It stays a
denylist of invisibles rather than an allowlist of printable ASCII, because a path or an
argument can legitimately carry non-ASCII text and refusing all of it would break working
servers to close a rendering hole.

**…and it left the C1 block, having banned both of its neighbours.** The revision above
took NEL (U+0085) out of the C1 controls and left U+0080-U+0084 and U+0086-U+009F in,
sitting directly beside a DEL (U+007F) it also banned. Verified against the validator
rather than reasoned about: all five probed code points were ACCEPTED, and two specs
differing only by U+0086 hashed differently while rendering as the same text — the identical
hole, in the range next door. The block is now taken WHOLE (`\u007F-\u009F`), for the same
reason U+2060-U+206F was taken as a range rather than code point by code point: a contiguous
family of zero-advance characters should not be enumerated, because the enumeration is what
leaves the gap. No argv or path legitimately carries one. Mutation-verified — narrowing the
class back to `\u007F\u0085` fails the every-invisible validator test, which now pins both
ends of C1 and either side of the NEL that was already there.

📌 **A denylist written by enumerating examples has a gap where the examples ran out.** Both
misses here are the same shape: the fix listed the characters someone had thought of, in a
range whose neighbours were already banned. The corrective habit is the one the second fix
applied — when banning a member of a contiguous block, ban the block.

**The audit row named the box, not the person.** `tool_approvals.decided_by` is documented
in migration 0004 as the user_id of the decider, and the decision surface — which had
already resolved the bearer in order to authorize the request — was discarding it and
passing this instance's slug. Every MCP approval read as having been decided by the box.
The bearer is now threaded through `decide`, with the slug kept only as the fallback for a
caller with no authenticated actor, because an empty decider would be worse than a coarse
one. The surface test's own fixture had `user_id` and `project_slug` both set to `'owner'`,
so it could not have caught this; they are now deliberately different, which is the more
durable half of the fix.

**Two round-3 blockers are NOT addressed here, and cannot be.** Both are review-lane
process gaps rather than code defects: the mandatory rubric lane never emitted a verdict,
and one cross-model lane failed or timed out. Nothing in this diff can close either — they
have to be re-run or explicitly waived before merge, and they are recorded here so their
absence is visible rather than assumed.

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

Round 3 added seven more, same discipline — broken, confirmed failing, restored
byte-identical:

| Mutant | Caught by |
| --- | --- |
| the installed-set resolve hoisted back above the warm branch | all 3 one-child-per-key tests (2 spawns, leaked tmpdir, 2 resolver calls) |
| the decrypting `resolve` moved back outside `readSecrets`' try | all 4 unreadable-secret tests |
| `revokeApproved` removed from the deny path | both deny-after-approve tests (the change-his-mind test correctly survives) |
| `remove()` restored to spec-write-then-revoke | both uninstall-ordering tests, including the injected mid-sequence failure |
| `decided_by` reverted to the project slug | the store attribution test + the surface attribution test |
| the invisible-character ranges narrowed back to the round-2 set | the every-invisible validator test |
| `ownerMcpStartupTimeoutMs` returns a flat 10 s (division removed) | both `MCP_TIMEOUT` tests — the 8-server aggregate and the floor |

One round-3 mutant deliberately does NOT fail a test, and that is the point: removing the
deny-revoke leaves "approve after deny re-wires it" passing, because that test exists to
stop the revoke being over-corrected into a permanent block. A guard test and an
anti-over-correction test have to fail on different mutants or one of them is not doing
anything.

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

Round 3 re-ran the same gates plus `bash scripts/ci/depcruise.sh`,
`depcruise-ratchet-guard.sh`, `composition-wiring-gate.sh`, `route-slot-ratchet-guard.sh`
and `composition-field-ratchet-guard.sh` — all pass, no new cross-band edge and no shrunk
baseline.

Two failures in the full local `scripts/run-tests.sh` run are PRE-EXISTING and were
verified as such by running each one against unmodified `main` in a separate checkout,
where both fail identically:

- `tests/integration/orphan-survival.test.ts` — the SIGTERM-cleanup case expects the booted
  gateway to exit 0 and gets 143 (raw SIGTERM) on both.
- `open/__tests__/open-projects-changed-wiring.test.ts` — the post-onboarding
  `projects_changed` fan-out case, on both.

Recorded rather than waved through: "pre-existing" is a claim that needs the control run,
and the control run is what makes it one. Neither touches this feature's files, and CI's own
`purity` (leak) and `typecheck` gates pass on the PR — the local leak-gate run is NOT
comparable, because it loads a broader personal denylist and reports the same class of
finding against unmodified `main` (README, SECURITY, `install.sh`).

---

## Round-3 review fix — `decide()` was not on the write chain

`install()` and `remove()` both ran inside `OwnerMcpServerStore.serialize`, the
in-process write chain. `decide()` did not, and it performs a read-modify-write over
`tool_approvals`.

**The orphaned approval.** An `approve` reads its spec and passes its grant-hash check;
a `remove()` then deletes the spec AND revokes the grant; the approve resumes and opens
+ resolves a *fresh* `approved` row for a server that no longer exists. The revoke is
simply lost — it ran before the row it was meant to kill existed.

The stray row is not the damage. Reinstalling the **identical** spec produces the same
grant hash, so `approvalStateFor` finds the survivor and the server comes back **WIRED
with no approval prompt**. For a feature that executes arbitrary commands, the owner's
only gate failing silently open is the worst available outcome. Two clients make the
interleaving ordinary rather than exotic: an uninstall from the tab landing mid-decision
on the phone.

`decide()` now runs inside `serialize`; its body moved unchanged into a private
`decideLocked` so the change is a lock rather than a rewrite. Nothing it calls is itself
serialized — `list()` and `requestApproval()` are both already invoked from inside
`install()`'s critical section — so there is no re-entrancy to deadlock on.

### The regression test took two attempts, and the first one was worthless

The first version parked inside `respondApproval` and **passed against the unfixed
code**. `remove()` sweeps *pending* rows, so that interleaving was already defended: the
approve was resolving the pending row `install()` had opened, and the sweep cancelled it.

The undefended window is narrower — it is the one where the approve **mints a fresh
grant**, i.e. the deny-then-changed-my-mind path, *after* the uninstall's sweep has
already run and found nothing to cancel. The test now denies first, parks inside
`openApproval`, and runs the uninstall in that gap. Mutating `decide` back off the chain
fails it with `Expected: "pending" / Received: "approved"` — the symptom itself.

📌 **A guard-fix's test is not finished when it passes; it is finished when the mutant
fails.** This one passed both ways for a whole cycle, and had it shipped it would have
read as coverage of a race it could not observe. The same file's header already claims
"each is written so that removing the guard makes it fail" — that claim is only worth
what the mutation run behind it proves.

📌 **A hand-listed fake drifts from the real surface.** The gate was first written as
four delegating methods, chosen by reading what `decide` calls; `remove()` then reached
`listPending` and died with a `TypeError` that read like a bug in the code under test. It
is a `Proxy` now: everything delegates, exactly one call is intercepted.

---

## Round-3 review fix — a revocation now retires what is already RUNNING

Revoking a grant was durable and immediate; the subprocess spawned under the old answer
was not. `claude` reads `mcpServers` once at startup, and `getOrSpawnSession`'s
`freshMcpServers` guard retires a stale child only ON A DISPATCH — which for an idle
session can be hours away. Until then a revoked server's stdio child kept running,
holding the environment it was handed, including any secret configured for it.

Three parts, because the seam crosses a layer:

* `runtime/…/persistent/pool.ts` — `evictWarmReplsForMcpSurfaceChange()`. An idle child
  is terminated and dropped from the pool now; a session with a turn in flight is marked
  `poisoned` instead, which the spawn path already treats like a failed freshness guard
  and respawns cleanly at the next boundary. Killing mid-turn would strand the turn and
  desync the channel correlation, and buys nothing — that turn is running under a grant
  that WAS in force when it started. Instance-wide, because installed servers are.
* `gateway/mcp-servers/store.ts` — an `onRevoked` dep, fired after `remove()`'s spec
  write (so a respawn reads the list without the server rather than racing the delete)
  and after a deny's revoke. A callback rather than an import: the store is
  persistence-layer, the pool is a runtime adapter, and the layering gate is right to
  refuse that edge.
* `open/composer.ts` — the line that connects them. Without it the seam exists and
  nothing calls it.

### What is proven, and what is NOT

Proven, mutation-verified: the store announces every revocation and no approval. Three
mutants — drop the announce in `remove()`, drop it on deny, let the eviction's failure
escape — each fail exactly ONE test, so none of the three checks is redundant.

**Now proven: a warm IDLE child IS terminated.** This section previously recorded the
opposite, and the reason it gave was wrong. It said a test had been attempted and failed
because the drained fake-pty session leaves its POOLED PROMISE REJECTED, so the eviction
loop's `await` throws and skips the entry. The pooled promise resolves fine. What is
actually still true the instant `drain` returns is that `session.activeTurn` is STILL SET
— the turn's bookkeeping is cleared after the completion event reaches the consumer, not
before it — so an evict issued on that tick correctly reads the session as BUSY and
poisons it. That is the `{evicted: 0, poisoned: 1}` the earlier attempt saw, and it is the
function behaving correctly rather than a harness defect.

Letting the queue drain first makes the idle path directly observable. The test
(`TERMINATES a warm IDLE child, rather than waiting for its next dispatch`) asserts
`{evicted: 1, poisoned: 0}` AND a real `PtyChild.kill()`, because a dropped pool entry is
not a dead child. Two mutants, two failures: make the busy branch unconditional (poison
everything, evict nothing — the no-op that reads as a fix) and drop the `terminateChild`
call while still evicting. The settle is a bounded TICK LOOP rather than a wall-clock
sleep, so it cannot flake on a slow runner.

📌 **Three lessons, and the last two each invalidated a claim this document had made.**

**A guard whose condition is never entered is a no-op that reads as a fix.** The first
draft decided "is this session busy?" by scanning `activeTurnRoutes`. `session.activeTurn`
is plain identity; the route delete is guarded on a RECOMPUTED key
(`activeTurnRoutes.get(activeTurnRouteKey(options))?.turn === turn`), and a key that does
not recompute to the one used at insert leaves a route behind for an idle session — so the
routes lookup is the weaker signal and `activeTurn` is the one used.

**But that difference is NOT covered, and this document claimed it was.** Substituting the
routes lookup back in leaves the entire suite passing, including the new idle-eviction
test: in every scenario it exercises, the key does recompute and the route entry is duly
deleted. The `evicted=0, poisoned=1` reading was real but had the other cause above. A
mutation test is the only thing that separates "my reasoning is sound" from "my test
proves it" — and here the reasoning was sound while the test proved something else.

**"Not covered because the harness cannot" deserves the same scrutiny as a positive
claim.** The rejected-promise diagnosis was specific, confident, and wrong, and it closed
off a path that needed one extra line to test. An impossibility claim about one's own test
harness is an absence claim, and absence claims are the ones that escape verification.

**A `replace` without an assert is a probe that cannot fail.** Three debugging runs were
wasted on instrumentation that silently patched nothing, and the empty output was read as
evidence about the code. The run that produced the real answer was the one whose every
anchor was asserted first. This is the same shape as the CLAUDE.md rule about a tool that
cannot read the format returning a negative that looks like an answer — here the tool was
my own edit script.

---

## What review round 4 changed

Three lanes this round (adversarial on Opus, rubric on codex, and codex) — the Kimi lane
was deliberately off, so the verdict is a THREE-lane one and is not the four-lane agreement
earlier rounds recorded.

Both round-3 fixes were re-verified against the tip rather than against the round-3
summary, and both hold under mutation:

- **`decide()` on the write chain.** Reverting `decide` to call `decideLocked` directly
  fails the interleave test with `Expected: "pending" / Received: "approved"` — the
  orphaned-approval hole, exactly as claimed.
- **Revocation retires the warm child.** Two independent mutants kill the idle-eviction
  test: dropping `terminateChild` leaves `kills.n` at 0, and treating every session as busy
  reports `poisoned: 1` instead of `evicted: 1`. The round-3 note calling this path
  uncoverable had already been retracted in this document; `docs/AS_BUILT.md` was still
  carrying the retracted version and has been corrected.

### THE ONE DEFECT FOUND — an install's reply could describe the wrong state

`requestApproval` fired and forgot `ApprovalManager.requestApproval`, whose promise
resolves only when the owner answers. Its callers then finish with `await this.list()`, and
the read side (`findByToolName`) is a SYNCHRONOUS `prepare().all()` that bypasses the db
mutex the INSERT goes through — so the pending row was present in the reply only when the
mutex happened to be idle.

Contention alone does not expose it: `install`'s own two writes queue on the same mutex, so
by the time it reaches the mint the mutex is idle again. The window is the ONE yield inside
the critical section that falls after those writes and before the INSERT — the
`await manager.cancelPending(...)` an EDIT takes to retire the previous spec's prompt. A
foreign writer taking the mutex at that instant put the INSERT behind itself, and
`install()` answered with the server it had just made a prompt for as `unapproved`.

Fail-closed (nothing was wired) and still approvable — the Approve control renders for
every non-`approved` state and `decide` mints a fresh grant when no pending row exists —
but the label read "Not approved — review the request below" for a server that had in fact
just asked, and the Deny button, which renders only for `pending`, was absent.

The fix is `await manager.openApproval(...)`: the same insert, minus the
wait-for-the-owner half. `openApproval`'s own docblock names this use, `decide` already
made the same call, and nothing in this store ever consumed the discarded waiter promise —
it reads the durable row, and the settings surface is the delivery channel — so this
removes a never-resolving promise rather than a behaviour.

📌 **A test that targets "the first call" is making a claim about call ORDER, and it
retargets silently when the order changes.** The round-3 interleave test parked the FIRST
`openApproval`, which was the approve's fresh grant only because `install` was not calling
`openApproval` at all. The moment `requestApproval` started awaiting its own mint, `install`
became the first caller and the setup deadlocked on a park meant for something else — a
15 s timeout in a test whose subject was untouched. The park is now ARMED at the line the
interleave begins, so what it intercepts is stated rather than inferred.

### Checked and left alone

- **A stale `deny` arriving after another client approved the same hash.** Not a hole:
  `decideLocked` revokes every approved grant BEFORE it records the denial and re-reads the
  rows afterwards, so the server is unwired and the reply is honest.
- **`decided_by`.** The HTTP surface passes the bearer it already resolved; the slug
  survives only as the fallback for a caller with no authenticated actor, of which this
  build's wiring has none.
- **The aggregate MCP startup budget.** `ownerMcpStartupTimeoutMs` divides a 20 s share of
  the 30 s ready budget across the servers actually wired, with a 2 s floor — and the
  docblock states plainly that past ~10 servers the floor wins and a serial worst case can
  still exceed the budget, which is a bound this knob cannot supply.
- **The invisibles denylist.** Now takes C1 and U+2060–206F as whole ranges plus the TAG
  block. What remains open is the CONFUSABLES class — an NBSP renders like a space, a
  Cyrillic `а` like an `a` — which no denylist closes and which the docblock already
  declines to close with an ASCII allowlist, because paths legitimately carry non-ASCII.
  Worth naming; not a regression, and not something this round should invent a fix for.
- **A slow test, not a failing one.** `A FAILED SPAWN STRANDS NOTHING` needs ~5.5 s, so a
  bare `bun test` (5 s default) reports it as a timeout while CI's `--timeout=15000` passes
  it. Verified green at the CI timeout; noted because the local-vs-CI gap reads as a real
  failure to anyone running the file directly.

## Re-review round (2026-08-10) — two of the previous round's "checked and left alone" were wrong

The round above closed its findings and listed five things it had checked and deliberately
not changed. Re-verified against the tip, two of those five did not hold.

### The invisibles denylist: ten of the fourteen were not confusables at all

The previous entry recorded the denylist as complete except for "the CONFUSABLES class — an
NBSP renders like a space, a Cyrillic `а` like an `a` — which no denylist closes". That is a
sound argument, and it covered four of the fourteen code points a reviewer had listed. It did
not cover the other ten, which are not confusables: they are default-ignorables that render
as nothing at all.

Probed against the exported regex itself, with positive controls to prove the probe could
return a refusal:

```
refused   U+200B, U+2060, U+0085, U+00AD, U+E0020      (positive controls)
ACCEPTED  U+034F  COMBINING GRAPHEME JOINER
ACCEPTED  U+180B  MONGOLIAN FREE VARIATION SELECTOR ONE
ACCEPTED  U+FE00  VARIATION SELECTOR-1
ACCEPTED  U+FE0F  VARIATION SELECTOR-16
ACCEPTED  U+E0101 VARIATION SELECTOR-18 (supplement)
ACCEPTED  U+2800  BRAILLE PATTERN BLANK
ACCEPTED  U+115F / U+1160 / U+3164 / U+FFA0  the HANGUL FILLERS
ACCEPTED  U+00A0 / U+2000 / U+2007 / U+3000  the space variants  ← the real confusables
```

The VARIATION SELECTORS SUPPLEMENT (U+E0100-U+E01EF) is the same default-ignorable family as
the TAG block (U+E0000-U+E007F) the regex already banned, 0x80 code points further along —
which is precisely the failure the TAG block's own docblock had argued against when it took
U+2060-U+206F "as one range rather than three, so an unassigned code point in the middle of
it cannot be the one gap". The regex now takes U+E0000-U+E01EF as one span, and adds the BMP
variation selectors, the combining grapheme joiner, the Mongolian free variation selectors,
the Braille blank and the Hangul fillers.

The four space variants stay ACCEPTED, and a test now asserts that they do, with the argument
written next to it: they advance, so a spec carrying one differs visibly; they are confusable
with U+0020 rather than invisible; and confusability is unbounded (the Cyrillic path the
existing test deliberately accepts is the same hazard). What bounds them is the grant hash,
not the regex.

📌 **A triage bucket is a claim.** Sorting a finding into a class that is legitimately out of
scope is how it stops being examined. Here the class was real and the sorting was wrong for
ten of fourteen items, and the whole list went out with it.

### An EDIT never retired the warm child

The entry above says a replace "does not touch the old approval row at all. It does not need
to" — true, and about the ROW. `announceRevocation()` was called from `remove()` and from
`decideLocked`'s deny branch, never from `install()`. So editing an approved server
un-approved it for the next spawn while the child spawned under the OLD grant kept running
the old command, with the old env values resident, until some later dispatch re-checked the
surface. For an idle session that is hours — the same window, and the same secret-residency
hazard, the round-3 eviction fix existed to close.

`install()` now announces when the grant hash changed. Gated on the hash rather than on
"is this an edit" so a byte-identical re-install, which leaves the grant matching and the
running child correct, does not buy a cold respawn for nothing. Env VALUE-only edits stay out
of scope here: the hash does not cover values and the spawn path's `freshCredential` guard
already owns them.

### Two pool races, found by reading rather than by a failing test

**`acquireTurn` → `activeTurn` is a window, and the evictor was blind to it.** A dispatch wins
the turn mutex, then does real async work before assigning `session.activeTurn`: `await
session.ready`, and on the import path the entire `/clear` context-reset interstitial, which
itself awaits the REPL going idle. `evictWarmReplsForMcpSurfaceChange` keyed busy-ness off
`activeTurn` alone, so a revocation landing in that window read a committed turn's session as
IDLE and terminated its child — stranding the turn, which is the one thing that function's
own docblock says it declines to do. `ReplSession.turnSlotHeld` is incremented the instant the
slot is won; the returned release is idempotent, because several of the driver's early-return
paths release the slot they were handed and a bare decrement would go negative and read as
idle.

**A session poisoned mid-turn could outlive the grant indefinitely.** Poisoning is a promise
that the NEXT DISPATCH evicts and respawns. Nothing in this build reaps an idle warm session —
checked with a positive control, since that is an absence claim — so if no next message ever
arrives there is no next dispatch, and the revoked server's stdio child keeps its environment
for the life of the process. `retireOnIdle` is set alongside the poison and honoured on the
turn's own completion path, after `release()` has dropped the slot count. Kept as a SEPARATE
field from `poisoned` on purpose: `poisoned` means "unfit for reuse" and is satisfied lazily
and correctly by the abandon-poison paths, which must not inherit an eager teardown.

Covered end to end rather than by hand-setting the flag: the fake child's reply is gated so a
turn is genuinely in flight when the revocation lands, then released. Mutants killed — remove
the settle-path retire and `kills.n` stays 0; revert the busy check to `activeTurn` alone and
the slot-holder test evicts a busy child.

### The two smaller ones

- **The mobile badge said `running`.** For the same `active` field the web badge says
  `approved`, and `McpServerStatus.active`'s docblock states outright that it is NOT a claim
  that a process is running — adding that "both clients' labels say that rather than
  'running'", which was true of one client. The status line directly beneath the badge said
  "starts it with its next session", so the card contradicted itself. The test written to
  prevent this (`NOT "running"`, in its own words) read only the `-status` element and could
  not see the badge; it now asserts on the whole card and pins the badge text.
- **`MCP_TIMEOUT`'s divisor undercounts by two.** The variable is process-wide and governs the
  in-process tools bridge and the dev-channel sink as well, while `spawn.ts` divides the 20 s
  share by the count of OWNER servers only — so the serial worst case is (N+2) shares, and at
  N=1 the true worst case is the whole 30 s ready budget rather than the 20 s reserved.
  Documented rather than corrected: making the divisor N+2 would cut the healthy one-server
  case from 10 s to ~6.6 s to bound two servers that are local to the box and effectively
  never slow, and the cost of the undercount is the same bounded, visible spawn failure the
  floor paragraph already describes.

### Confirmed sound on re-verification

- **`decide()` on the write chain.** The orphaned-approval interleave is closed, and the
  regression test earns it: parking is ARMED at the line the interleave begins rather than
  targeting "the first `openApproval`", and removing the `serialize` wrapper fails it.
- **The stale `deny`.** `decideLocked` revokes every approved grant before recording the
  denial and re-reads the rows afterwards, so a deny cannot report success over a live
  approval.
- **`decided_by`.** `gateway/http/app-mcp-servers-surface.ts` passes the bearer it already
  resolved; the slug is only the no-authenticated-actor fallback.
- **The install reply.** `await manager.openApproval(...)` is present at the committed tip,
  and the fire-and-forget mutant still fails its test with
  `Expected: "pending" / Received: "unapproved"`.
- **The untrusted substrates.** `cc-import-*` and `cc-trident-*` still receive no owner MCP
  server even when handed the resolver — the second gate in `spawn.ts` is asserted
  independently of the wiring.

## Round 5 — the two the panel found still open

Both were real, both reproduced, and both are the same class: a warm REPL replaced or retired
without accounting for a turn already committed to it.

### One replacement per pool key

`getOrSpawnSession` was unserialized. The cold path is protected by a documented property —
nothing suspends between its `pool.get` and its `pool.set`, so a second caller observes the
first's in-flight promise — but that property covers the COLD path only. The warm-eviction
path suspends twice on purpose: at `await existing`, and (since the installed-MCP guard
landed) at `await options.resolveExtraMcpServers()`. So two dispatches arriving after the
owner installed or revoked a server both awaited the same warm session, both computed
`freshMcpServers === false`, and both ran evict → terminate → spawn → `pool.set`. The second
`pool.set` overwrote the first: two `claude` children resuming ONE transcript, the loser
orphaned outside the pool and therefore invisible to `shutdownAllPersistentRepls`, still
holding its 0600 MCP config. That breaks the one-REPL-per-key invariant in
`runtime/adapters/claude-code/AGENTS.md` precisely when the owner touches MCP settings, and
the same shape was reachable through the credential-rotation guard, which suspends at
`await existing` alone.

Fixed with a per-key lock (`withGetOrSpawnLock`) around the whole body rather than a re-check
after each suspend: the awaits are load-bearing — the resolver has to run for the fingerprint
comparison to exist at all — so a re-check would have to re-derive "is the session I awaited
still the pool's session" at every one of them, and every future await added there becomes a
new place to get that wrong. It costs a concurrent caller no latency it was not already
paying, since it awaited the same spawn promise via `pool.get` before. The uncontended path
takes no await, so the cold path stays straight-line and its own comment stays true; that
comment now records that the lock is what guarantees one child per key and the no-suspend
property is the second line of defence, because leaving it claiming to be the only mechanism
would be a doc describing a mode the code no longer depends on. Mutant killed — bypass the
lock and the new test spawns 3 children where it expects 2.

### A queued dispatch is busy too

The round-4 `retireOnIdle` teardown could strand the very turn the poison-instead-of-kill
branch exists to protect. `turnSlotHeld` was incremented AFTER `await prev`, so a dispatch
parked in `acquireTurn()` behind the active turn counted for nothing: the active turn's
release dropped the count to zero, the turn-completion path read the session as idle and
retired the child, and the queued dispatch then resumed from `await prev` into a dead REPL.
Reproduced as `drain error: persistent-repl: REPL process exited`.

The count is now taken BEFORE the wait. A queued caller has already passed the freshness
guards and bound itself to that child, so it is committed work, and the revoked child is
retired when the QUEUE drains rather than when the active turn ends — the same bargain the
poison branch already strikes. `turnTail` is only ever resolved, never rejected, so the
pre-wait increment cannot leak. Mutant killed — move the increment back after `await prev`
and the queued turn dies mid-flight.

## Round 6 — the eviction sweep could kill a child a committed dispatch was about to use

The round-5 teardown answered "is this session busy?" from `session.activeTurn` and
`session.turnSlotHeld`. Both live ON a `ReplSession`, and both are set by the CALLER after
`getOrSpawnSession` has already handed one back — so there are two populations the pair
cannot describe at all, and the sweep read both as idle and killed their children.

**A COLD SPAWN IN FLIGHT.** The pool holds an unresolved promise; no session exists yet.
The sweep awaited it, and its continuation resumes several await-hops before the
dispatch's own, so it saw a brand-new session with no turn and no slot, called it idle, and
terminated the child the dispatch was about to inject into. Measured on the test harness
before the fix: `evicted=1`, one kill, and the turn failing its drain. `pendingSpawns`
(`runtime/adapters/claude-code/persistent/pool-state.ts`) is the synchronous answer, in the
same spirit as `childByKey` — a `Promise` cannot be asked whether it has settled, and
asking by awaiting it is the observation that changes the answer.

**A DISPATCH PAST THE GET-OR-SPAWN AND SHORT OF `acquireTurn()`.** `committedDispatches`
covers this one, and the span is not microtask-sized: the warm-reuse branch computes the
MCP freshness fingerprint by awaiting `options.resolveExtraMcpServers()`, which in the real
composition reads the installed list out of the database and decrypts every env value. An
earlier revision of the docblock wrote this window off as "a handful of microtasks — the
async unwind out of `getOrSpawnSession`"; that was wrong, and a reviewer reproduced a
failed dispatch by gating that one resolver.

Neither branch AWAITS. Both mark on resolution — `poisoned` so the next dispatch cannot
reuse a child spawned under a withdrawn grant, `retireOnIdle` so the turn's own completion
path tears it down the moment the queue drains. That is also what stops a deny or an
uninstall from blocking on a cold spawn's whole ready budget.

Mutant killed: disable the pending branch and
`a COLD SPAWN in flight is busy too` fails — `{evicted: 1}`, one kill, and
`drain error: persistent-repl: spawn failed (no-channel-ready)`.

### `retireOnIdle` was honoured on exactly one exit path

The teardown sat after the normal completion path, so every early return walked past it: a
turn cancelled before or after the context reset, and — the one that mattered — a turn that
crashed during inject on a still-LIVE child. That session kept its revoked child until some
later dispatch happened to evict it. The check now lives in the driver's `finally`, LAST, so
the watchdog's outstanding-turn settle is not delayed behind a SIGTERM grace window. Every
early return releases the turn slot before returning, so they all arrive there in the same
idle state the normal path does.

### Rotating only a VALUE never announced the revocation

`install()` gated the announcement on a grant-hash change, and a comment credited the spawn
path's `freshCredential` guard with covering the rest. It does not: `freshCredential`
fingerprints the CLAUDE OAuth token (`authFingerprintFor`) and knows nothing about MCP env
values. The guard that does fold them is `freshMcpServers` — and it only runs ON A DISPATCH,
which for an idle session is hours.

Which makes this the worst of the four revocation shapes to have missed, because rotating a
secret is usually the owner's response to believing the old one is compromised, and the
child holding the old value stayed alive unbounded while he was quiet. `install()` now
compares the stored values against the incoming ones (`sameEnvValues`, read before the
overwrite, never logged) and announces on either a hash change or a value change. The grant
is deliberately unchanged in the value-only case — the approval still holds and the server
stays wired; it is only the PROCESS that has to go.

Mutant killed: drop `|| valuesChanged` and `ROTATING ONLY A VALUE announces it` fails.

### The announcement was holding the store's write chain

`announceRevocation()` reaches into the REPL pool, where it can wait on a SIGTERM grace
window or a cold spawn's ready budget — and it was called from INSIDE `serialize`, so a deny
arriving mid-spawn held the settings write path, and every queued install behind it, for as
long as the spawn took. Every caller now sets a local flag in its critical section and
announces once the chain is released. Correctness never depended on the position: the revoke
is durable first, so a spec written in between is one the eviction's respawn reads correctly
anyway. It is still AWAITED by the caller, so the HTTP reply never claims a stop that has not
happened.

The new test makes the eviction slow on purpose and asserts a concurrent install COMPLETES
while it is parked. Without the fix that test deadlocks rather than failing, which is the
defect stated precisely: the second write cannot start.

### The invisibles denylist stopped being a hand-maintained list

Five revisions of an enumerated character class, each closing the code points one reviewer
had probed and leaving the next batch open. The fifth probe found 25 more still accepted —
the Arabic and Indic number signs, the Egyptian Hieroglyph and Duployan and musical format
controls, the Khmer inherent vowels — every one zero-advance, every one able to make two
hash-distinct specs print identically.

A sixth revision then found the tail of the very block the fifth had claimed to take
"whole": `U+E01F0`-`U+E0FFF`, plus `U+FFF0`-`U+FFF8`. The lesson finally took. The class is
now four general categories — `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}` — plus
`\p{Default_Ignorable_Code_Point}`, and one named code point.

`Default_Ignorable_Code_Point` is what every hand-written range was groping for. It covers
everything a conforming renderer must draw as nothing INCLUDING the code points reserved for
that and not yet assigned (`U+2065`, `U+FFF0`-`U+FFF8`, `U+E0002`-`U+E001F`,
`U+E0080`-`U+E00FF`, `U+E01F0`-`U+E0FFF`) — and unassigned is exactly what no general
category matches, which is why the enumeration needed ranges and why its ranges kept ending
too early. Every hand-listed code point the previous revision carried is default-ignorable
and is now covered by property rather than by name. `U+2800` (BRAILLE PATTERN BLANK) is the
one exception: it is `So`, a renderer genuinely draws it, it just has no dots, so no property
reaches it.

Swept over all `0x110000` code points and verified a STRICT superset of the predecessor:
4274 refused against 665, so 3609 newly closed and none lost. Non-ASCII paths and arguments
in Cyrillic, Japanese, Arabic and accented Latin are still ACCEPTED, because refusing all
non-ASCII to close a rendering hole would break working servers, and the whitespace
confusables are still accepted deliberately (they advance; they are a different, unbounded
problem the grant hash bounds instead).

The guard against a seventh revision is mechanical rather than another list: a test carries
the predecessor regex as a literal and re-sweeps the whole code space, so NARROWING the class
fails instead of silently re-opening. Mutation-tested both directions — deleting the property
names 429 re-opened code points; substituting the predecessor wholesale accepts 3609.

The test titles were corrected in the same pass. One claimed to refuse EVERY invisible while
walking a curated list, which is the thing this whole history proves impossible; it now says
it is a regression list and points at the sweep for the completeness claim.

### The spawn-driving test file had no timing headroom

`readyBudgetMs`/`healthBudgetMs` are 5000 in that file's options and bun's default per-test
timeout is also 5000, so a fake spawn taking its full budget on a loaded machine was killed
by the RUNNER at the instant the code under test would have succeeded — and the kill landed
mid-`afterEach`, cascading into unrelated failures. Measured on a contended box: 26 pass / 3
fail, and 29 pass / 0 fail with `--timeout 90000`. `setDefaultTimeout(90_000)` raises the
runner's patience rather than shrinking the budget, because the budget is what lets a
genuinely slow spawn succeed; shrinking it would make the suite flakier on exactly the slow
machines this is about.

### A revocation could kill the child of a dispatch that had not yet taken its turn slot

The reproduced BLOCKER, and the one whose earlier partial fix was defended with a wrong
number. `acquireTurn()` runs in the CALLER's continuation, after `getOrSpawnSession` has
already resolved — so for the whole span in between, a committed dispatch has a session and
neither `activeTurn` nor `turnSlotHeld`. A revocation landing there read the session as idle,
killed the child, and the dispatch injected into a corpse: the turn failed with a drain error
instead of delivering.

An earlier revision closed the COLD half of this (a spawn still in flight, via
`pendingSpawns`) and wrote the warm half off in a docblock as "a handful of microtasks — the
async unwind out of `getOrSpawnSession`". That was measured wrong by reading the code: the
warm-reuse branch computes the MCP freshness fingerprint by awaiting
`options.resolveExtraMcpServers()`, and in the real composition that resolver reads the
installed list out of the database and DECRYPTS every env value through the secrets store.
The window contains real I/O, on the exact path a revocation runs concurrently with — which
is why a reviewer could reproduce a failed dispatch simply by holding that one resolver open.
A docblock that is confidently specific about a window's width is worth checking against the
code inside it.

`committedDispatches` is now a count, per pool key, of dispatches between the get-or-spawn and
the turn slot. The turn driver increments before the get-or-spawn and decrements in the
`finally` that already covers every unwind — return, throw, cancel, timeout — and the evictor
reads it synchronously alongside `pendingSpawns`, treating either as busy: poison the session
when it resolves, never await it. Not awaiting is load-bearing twice, because awaiting is what
broke the cold case and because awaiting a cold spawn would make a deny or an uninstall block
for the whole ready budget.

`pendingSpawns` is kept rather than folded in: the supervision crash/wedge respawn calls
`getOrSpawnSession` with no dispatch behind it, so the counter never sees that one.

Both docblocks that overstated were corrected. The claim that `turnSlotHeld` "covers the gap"
now says which stretch it covers and which it does not.

Tested by parking a second dispatch inside the freshness check — the production window, not
an arbitrary await — running the revocation there, and asserting the turn still DELIVERS.
Mutation-tested: with the committed check disabled the test fails with the drain error that
was the original user-visible symptom.

### Nothing asserted that the composer wired the revocation hook

The store is persistence-layer and cannot import the REPL pool, so it announces a revocation
through an `onRevoked` callback the composer supplies. Deleting that one property left every
store test passing (they build their own store with their own spy) and every pool test passing
(they call the evictor directly) — while a revoked server's stdio child kept running with the
environment it was handed. Built-but-never-wired, in the one place where the consequence is a
live subprocess outliving its grant.

Now pinned against the REAL composer: plant a warm idle session in the pool, uninstall through
the real HTTP surface, assert the child DIED and the pool entry is gone. Mutation-tested by
deleting the `onRevoked` property, which fails it.

### A test block's title contradicted its own suite

`a VALUE never leaves the encrypted store` sat one describe below `resolveApproved returns the
spec plus the decrypted env` — which is the whole point of the feature, since a stdio server
cannot start without its secret in the child's environment. A blanket "never" reads as a
stronger invariant than the code has, and the next reader to find the decryption would be
right to distrust the surrounding titles. Retitled to the true invariant: a value leaves by
exactly ONE route, and every other surface carries names only.

### Not fixed, and why

The review's first BLOCKER was that three of the four mandatory review lanes did not
complete (a rubric runtime timeout and two cross-model calls that timed out or lost auth).
That is a finding about the review harness, not about this branch — there is no code change
here that can answer it, and it is recorded rather than silently dropped.

**An MCP surface change evicts warm children that never received the resolver.** Only the
live-agent wiring is handed `resolveExtraMcpServers`; other warm workflows are not, so
evicting them costs a respawn and buys no security. Left as it is. The fix would be to skip
sessions whose owner-MCP fingerprint is empty — and that trades an over-eviction, which
costs latency, for a possible under-eviction, which would leave a revoked server's child
alive if the fingerprint were ever read wrong. On the one feature here whose entire purpose
is a gate, the fail-safe direction is worth a respawn. Eviction stays instance-wide, which
is also what the installed set is.

**Nothing bounds the AGGREGATE owner-server startup against the 30 s ready budget.**
`MCP_TIMEOUT` is per-server; the code divides a 20 s budget across the installed servers but
stops at a 2 s floor, because dividing further would fail healthy servers. `MCP_SERVERS_MAX`
is 24, so the serial worst case is 24 x 2 s = 48 s and can exceed the budget. Left as it is,
and documented at the constant rather than papered over: it requires 24 servers that all
HANG, the failure is bounded and visible (the spawn fails its assertion and takes the
bounded-respawn ladder, with `claude` naming the server that did not start), and the only
real fixes are a concurrent load or a bigger budget — neither of which a per-server timeout
can express. The tests pin the divide and the floor and explicitly do not claim the floor
closes the gap.

### Round-3 verification, including what failed and did not count

`typecheck-all.sh` exit 0 and `lint.sh` exit 0 on the final tree — the second only after a
fix, because the eviction path's mark-on-resolve tripped two gates in sequence: first the
bare-`void`-promise gate, then the pre-swallow gate, which correctly refused a two-arg
`.then` that hides a rejection from the wrapper's counter. It ends up on
`neutralizeAbandonedSettle`, which is the right primitive: the only way that derived promise
rejects is a spawn failure, which the spawn's own `catch` already un-pools and logs.

The five MCP suites run 160/160, and the pool suite 31/31.

**CI is 13/13 green on the rebased tip** — typecheck, lint, purity, layering, all four test
shards, the `test` aggregator, and the three CodeQL analyses. That is the authoritative
full-suite result.

It is recorded second because the local attempt to get there is worth writing down. A single
local `bun test` is not the suite: it was SIGKILLed at exit 137 partway through, which is why
CI shards across four runners in the first place. Sharded the same way locally — but four
shards sequentially on one already-loaded box — three files failed:
`tests/integration/orphan-survival.test.ts` (SIGTERM cleanup / WAL),
`open/__tests__/open-projects-changed-wiring.test.ts`, and `migrations/runner.test.ts`
(explicit db-path arg).

None is in a file this round touches, and none is a defect. The first two were reproduced at
`origin/main` in a separate worktree — so not this branch's — and the third passes in
isolation here, needing ~15 s alone against a 15 s per-file limit. CI then ran all four
shards green, which resolves what the local run could only bound: these are failures of a
contended box, not of `main`. Worth stating plainly, because "fails on main too" is the kind
of true-but-misleading line that would send the next reader to debug `main`.

CI note, recorded because it would otherwise read as a skipped gate: the `ci` workflow did
not fire for the first push of this round at all. Actions stalled repo-wide for ~45 minutes —
no `ci` run for ANY commit in that window — and the PR was left stuck reporting CONFLICTING,
which is why nothing queued: `pull_request` will not build a merge ref it believes is
conflicted. The branch was genuinely clean against `main` throughout (`git merge-tree`
merged with no conflict, and `origin/main` was an ancestor of the head). A rebase onto
current `main` cleared the stale status and the checks ran.

## Round 4 — the second writer, and a deferral with no receiver

Three lanes this round (adversarial on Opus, rubric on codex, codex), with the Kimi lane
deliberately absent rather than failed. Eight findings arrived; **four were already fixed on
this branch by rounds 2 and 3**, and one was false. Verifying before fixing is the whole
report, so the disposition is recorded per item.

### The one that mattered: `mcp_env.*` had two writers

`gateway/mcp-servers/store.ts` stores each installed server's env VALUES in the
`project_credentials` table under `mcp_env.<name>`, at global scope, because it wanted that
table's AES envelope rather than a fourth one. `sanitizeService` accepts `.`, so that
namespace was **a perfectly legal generic service name** — and
`gateway/http/project-credentials-surface.ts` exposes `POST /api/app/credentials` and
`DELETE /api/app/credentials/<service>` over it.

Both reached the namespace, and both skipped the thing that makes a rotation safe: the
`onRevoked` announcement that retires the warm `claude` child still holding the OLD secret
in its environment. So a generic overwrite rotated a secret **while leaving the process that
holds the previous one alive and unreaped** — and rotating is usually the owner's response to
believing the old value is compromised. The delete direction was worse: it left the server
installed, approved, secret-less, and that same child running.

The namespace is now RESERVED in `project-credentials/store.ts`. `set`, `delete` and
`resolve` refuse it; the owning module reaches its rows through explicit `setReserved` /
`deleteReserved` / `resolveReserved`. Separate methods rather than an options flag, so the
privileged path is greppable and a would-be second writer has to name it. The read direction
is closed too — no caller in this build resolves an owner-supplied service name, so this is
against a future one, and it answers `null` rather than throwing because an unset service is
a state every consumer already handles whereas a throw would be a new failure mode on the
turn path.

The enumerations (`listGlobal`, `listForProject`, and `listAvailableServices` transitively)
now omit reserved rows. Two reasons, both real: the Admin tab was rendering one row per
installed MCP server next to the owner's actual credentials with a Delete button that now
correctly refuses, and the agent's `<available_services>` block was advertising an MCP
server's secret blob as an external service it could use.

`handleDelete` gained a `try`/`catch` → `mapWriteError`. Without it the refusal answered
**500 for what is a 400** — the caller asked for something the surface must not do.

### The deferral that had no receiver

`evictWarmReplsForMcpSurfaceChange` treats a pending spawn as busy and marks it
`poisoned` + `retireOnIdle` rather than awaiting it. For a COMMITTED dispatch that is right —
its `finally` retires the child the moment it goes idle. But `pendingSpawns` catches a second
population with **no dispatch behind it at all**: the supervision crash/wedge respawn and an
admin respawn both call `getOrSpawnSession` directly, so `committedDispatches` never counts
them and no turn driver ever runs. Both flags were set correctly on a session nobody would
ever ask about, and the freshly-resolved child kept running under the REVOKED configuration
until some future dispatch arrived — unbounded, on a quiet instance.

The callback now DECIDES rather than merely marks: it retires a genuinely idle session
itself, and defers only where the deferral has a reader. The guard is the turn-completion
path's own, re-read AFTER the spawn resolves rather than trusted from the synchronous
snapshot, so a dispatch that committed mid-spawn is still spared. Flags are still set first,
so a failed teardown still refuses reuse.

Note the shape: **a test asserting on the two flags would have PASSED against this bug.**
They were both set, and correctly. What was missing was a reader. Only a probe that parks the
spawn and drives the revocation can see it, which is why the new test does exactly that and
calls no `substrate.start()` anywhere.

The docblock's "both are answered the same way — mark on resolution" was corrected. It was
accurate about the mechanism and wrong about the coverage, which is the shape the repo's
rule 3a is about.

### The partial-failure edit path

`install` writes the spec FIRST, deliberately — a fresh spec hashes differently, so the
fail-closed direction is "unapproved". That write is also the instant the durable spec stops
authorizing what the warm child is running. Everything after it can throw, and a throw
unwound out of `serialize` **without ever reaching the `revoked = true` that sat at the end
of the critical section**, so the old approved command kept running with the durable spec no
longer describing it and nothing scheduled to reap it.

The flag is now set immediately after the invalidating write, and announced from a `finally`.
The same shape applied to `remove` (revoke lands, then the forget and the spec write can
throw) and to `decide` (a deny revokes, then `respondApproval` can throw) — a stop button
reporting failure while the process it was meant to stop lives on. All three now announce
from a `finally`. In `remove` the mark moved to the revoke itself; that does not re-open the
race its old comment guarded, because the revoke already means `resolveApproved` refuses the
server whatever the list says.

### Already fixed, verified rather than re-fixed

- **Concurrent `start()` spawning two REPLs on one key** — fixed in round 3 by
  `withGetOrSpawnLock` (`runtime/adapters/claude-code/persistent/spawn.ts`), which serializes
  the whole get-or-spawn body per key and covers the warm-eviction path's two deliberate
  suspends.
- **Eviction killing a running dispatch in the get-or-spawn → acquire-turn window** — fixed
  by `committedDispatches` (`runtime/adapters/claude-code/persistent/pool.ts`), and the
  "`turnSlotHeld` covers the gap" overstatement was already corrected in the same round.
- **The enumerated invisible-character denylist** — already property-based:
  `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀` in
  `runtime/mcp-servers.ts`. The finding cited the pre-fix line numbers.
- **The "refuses EVERY invisible" test title** and the "a VALUE never leaves the encrypted
  store" describe title — both already renamed to what they check.

What was left of the invisibles finding is real and now stated: **canonical equivalents.**
`/bin/café` composed (U+00E9) and decomposed (`e` + U+0301) render IDENTICALLY and hash
differently. Neither available fix is right — normalizing to NFC changes the bytes that get
exec'd and macOS stores filenames decomposed, so a path copied from a real directory entry
would be rewritten into one that need not resolve; refusing non-NFC rejects those same
legitimate paths. What bounds it is the hash, not the charset. Documented in the docblock and
pinned by a test, so banning or normalizing becomes a deliberate edit to a failing assertion
rather than a silent widening.

The aggregate-startup-budget finding (2 s floor × 24 servers = 48 s against a 30 s ready
budget) was left as it is, because `runtime/adapters/claude-code/persistent/signatures.ts`
already states the tradeoff accurately and at length: dividing the budget past ~10 servers
produces a timeout so short that healthy servers fail, the floor wins, and the cost is a
bounded visible assertion failure with `claude` naming the server that did not start. A
genuine fix needs a concurrent load or a larger budget. That is a documented decision, not an
aspirational docblock.

### The false one

A reviewer reported `retireOnIdle` as write-only — "set dirty, declared, read nowhere". It is
read, in the turn-completion teardown guard in `runtime/adapters/claude-code/persistent/pool.ts`,
and asserted by two tests in
`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts`. The reviewer's
own cited grep was `reapIdle|IDLE_TTL|idleTtl|maxIdleMs` — **none of those symbols exist in
this tree**, so the search could not have found the read it claimed absent. A tool that
cannot match the thing returns an absence that reads like an answer; the control is to grep
for a string you know is present. Not fixed, because there was nothing to fix.

### Mutation log — every fix has a mutant that was RUN and died

| Mutation | Result |
|---|---|
| `RESERVED_SERVICE_PREFIXES` → a name nothing uses | 5 fail / 21 pass — set, delete, case-shift, resolve, enumerations |
| Unwrap `handleDelete`'s `try`/`catch` | 3 fail — the refusal answers 500, not 400 |
| Move `markRevoked()` back below the credential write | 1 fail — `calls` 0, expected 1 |
| Delete the self-retire branch | 1 fail — `kills.n` 0, expected 1: the child survives its own revocation |
| Drop the `committedDispatches` term from the self-retire guard | 6 fail, incl. 4 pre-existing — the committed dispatch is stranded |

The last one is the useful one: it proves the new branch did not buy the no-dispatch case by
breaking the committed case, which is the regression this fix could most easily have
introduced.

The security invariants were re-checked and hold: an unapproved server is never wired; a
changed command, args or env-var NAMES requires re-approval; the prompt renders what is
granted and never a value; `cc-import-*` and `cc-trident-*` receive nothing; the session MCP
config stays `0600`.

## Round 7 — the advertised maximum was a number the startup bound could not honour

Round 4 closed with the aggregate-startup-budget finding left open, on the reasoning quoted
two sections up: the docblock states the tradeoff accurately, the floor exists because
dividing further fails healthy servers, and the residual failure is bounded and visible. That
reasoning was sound about the FLOOR and wrong about the CAP, which is the half nobody
examined. Both reviews that looked at it compared the floor against the ready budget and
accepted the mismatch. Neither asked why `MCP_SERVERS_MAX` was 24.

Nothing derived it. `runtime/mcp-servers.ts` carried `export const MCP_SERVERS_MAX = 24` under
the comment "Most servers one instance may install" — a number picked independently of the
arithmetic that has to honour it. `runtime/adapters/claude-code/persistent/signatures.ts`
divides a 20 s budget between the wired servers and stops at a 2 s floor, so 24 servers permit
48 s of owner-server startup against the 30 s `readyBudgetMs` in
`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts`. The cap is the ONLY free
variable of the three: the budget is a share of the ready window on the owner's primary
conversational REPL and cannot grow, and a shorter floor fails servers that are working.

So the cap is now derived — `OWNER_MCP_STARTUP_BUDGET_MS / OWNER_MCP_STARTUP_TIMEOUT_FLOOR_MS`
= 10 — and the aggregate fits at every count the owner can reach instead of only at small
ones. This is a real product-surface reduction: `GET /api/app/mcp-servers` now advertises
`max_servers: 10`, and `gateway/mcp-servers/store.ts` refuses the eleventh install. Ten stdio
subprocesses on one box is well past what a single owner runs, and the alternative was
continuing to advertise a ceiling of 24 while the code could only bound 10 — a promise, not a
limit.

It is a literal rather than an import because `runtime/mcp-servers.ts` is substrate-neutral
and those two constants belong to one adapter. The equality is pinned instead by a sweep in
`runtime/adapters/claude-code/persistent/__tests__/owner-mcp-servers.test.ts`, so raising the
cap without raising the budget fails CI.

### The test that documented the gap now closes it

The old assertion was `expect(FLOOR * MCP_SERVERS_MAX).toBeGreaterThan(BUDGET)` under the
title "does not pretend the floor closes the gap". It was honest, and it pinned the defect in
place: a test asserting that the numbers DISAGREE passes forever and reads as intent. It is
now `toBe(BUDGET)`, plus a loop over every count from 1 to the maximum asserting
`ownerMcpStartupTimeoutMs(n) * n <= BUDGET`. The loop is what covers the middle of the range,
where the division rather than the floor is the bound.

Three docblocks were corrected in the same change, because each described the old state.
`signatures.ts` claimed `MCP_SERVERS_MAX` "permits far more" and that "the serial worst case
CAN then exceed the ready budget"; the paragraph on the `(N + 2)` undercount then referred to
"the same bounded, visible failure the floor paragraph describes", a cross-reference to a
failure that paragraph no longer describes. A stale docblock that points at another stale
docblock is how the next reader inherits the wrong model of the system.

### What this deliberately does NOT close

`MCP_TIMEOUT` is process-wide, so it also governs the two compiled-in servers (the in-process
tools bridge and the per-session dev-channel sink) and the true serial worst case is `(N + 2)`
shares, not `N`. At N=1 that is 3 × 10 s = the whole 30 s budget. Correcting the divisor is
still refused for the reason already documented — it would shrink the healthy one-server case
from 10 s to ~6.6 s to bound two local processes that are never slow — and the derived cap
does not change that. Both the docblock and the test now say so in the same place they assert
what IS closed, rather than leaving the reader to discover the difference.

### Mutation log — both mutants RUN, both dead

| Mutation | Result |
|---|---|
| `MCP_SERVERS_MAX` back to 24 | 1 fail — `Expected: 20000, Received: 48000`; the exact arithmetic the finding described |
| `Math.floor` → `Math.ceil` in `ownerMcpStartupTimeoutMs` | 1 fail — `Expected: <= 20000, Received: 20001` |

The second mutant is the one worth keeping. Every endpoint assertion in that test still passes
under it — n=1, n=2, n=4 and n=`MAX` are all unchanged by the rounding — so it dies ONLY in
the sweep, which is the proof the loop carries weight rather than decorating the assertions
around it.

### Verified rather than re-fixed

Seven of the eight items handed to this round were already closed on the branch by rounds 4–6,
and were re-read in the code rather than trusted from the brief: the `mcp_env.*` reservation
with its `*Reserved` methods and 400 mapping (`project-credentials/store.ts`), the
`getOrSpawnLocks` serialization of warm replacement (`spawn.ts`), the `committedDispatches`
term that closes the get-or-spawn-to-`acquireTurn` eviction window (`pool.ts`), the evictor's
self-retire for a spawn with no dispatch behind it, the `finally`-based revocation announce on
the partial-failure edit path (`gateway/mcp-servers/store.ts`), the property-based invisibles
regex, and the two over-broad test titles. The `retireOnIdle` "write-only" report remains
false and was again left alone.

The security invariants were re-checked against this change specifically. Lowering a count cap
cannot widen a grant: an unapproved server is still never wired, a changed command, args or
env-var NAMES still requires re-approval, the prompt still renders names and never a value,
`cc-import-*` and `cc-trident-*` still receive nothing, and the session MCP config is still
`0600`.
