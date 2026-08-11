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
