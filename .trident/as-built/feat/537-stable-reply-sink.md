## 2026-09-12 — the reply sink gets durable coordinates: a per-instance port and a token on disk

A REPL could not outlive its gateway, and the reason was two lines in
`pool-state.ts`: the reply sink bound `port: 0` and minted
`randomBytes(24).toString('hex')` per process. Both values are baked into every
spawned child at spawn time — the per-session MCP config env (`spawn.ts`:
`SINK_PORT` / `SINK_TOKEN` in the `mcpServers` entry) and the settings hooks, as a
literal shell env prefix (`build-settings.ts`, the TodoWrite and activity-tap hook
commands). The child reads them once at startup (`dev-channel-impl.ts`:
`const SINK_PORT = parseInt(process.env['SINK_PORT'] || '0', 10)`) and POSTs to
`http://127.0.0.1:${SINK_PORT}` for the rest of its life. There is no protocol to
re-point a running bridge.

So a restarted gateway had a new port and a new secret, and every surviving
dev-channel POSTed `/reply`, `/channel-ready` and `/tool-call` into a dead port
with a stale token — silently. And the bridge really does survive: it exits when
*claude's* stdio closes (`dev-channel-impl.ts`'s `mcp.onclose` / stdin `end`),
which a gateway restart does not touch once the REPL is hosted outside the gateway
process. This is ISSUES #537, the blocker under #539.

### What changed

Both coordinates are now reproducible by the next process, and neither has a
quiet fallback.

- **`runtime/adapters/claude-code/persistent/sink-coordinates.ts` (new).** The
  durable coordinates as a leaf: `deriveSinkPort(stateDir)`, the validating
  chokepoint `resolveSinkPort`, and `loadOrCreateSinkToken(path)`.

  THE PORT IS DERIVED PER INSTANCE, not fixed per box. The first two revisions used
  one global port, and adversarial review measured what that cost — a held 18537
  turned `tool-bridge.test.ts` into 1 pass / 8 fail; three suites run concurrently
  lost 2/7/5 tests where `origin/main` lost none; a live gateway on the box would
  own the port the moment it deployed, and trident builds run `bun test` on that
  same box; and a second instance could never bind at all, hard-failing every spawn
  until a human set an override nothing generates. `NEUTRON_HOME` is already
  per-instance and the token path is already derived from it, so the port is now a
  SHA-256 of that same state dir folded into `18537 … 32767` — above the privileged
  ports, below the ephemeral range the kernel hands out. Stable across restarts of
  one instance (the property #537 needs), different per instance, and different for
  every test process, whose preload gives each one a fresh `mkdtemp` home. All three
  reproductions were re-run against the fix: 9/9 with 18537 held, and 19/31/5 with
  0 fail twice concurrently — the same numbers as `origin/main`.
  A hash can collide (~1 in 14 000). The loser gets the loud EADDRINUSE failure
  naming the port and the override, because probing for a free port would make the
  value depend on who else was up at the time, which is the non-reproducibility
  this module deletes.

  `resolveSinkPort` is the ONE chokepoint all three sources pass through — the
  `sinkPort` option, `NEUTRON_REPL_SINK_PORT`, then the derivation — and both
  overrides are validated there. The first revision validated only the env value and
  handed the option straight to `Bun.serve`; both review gates measured the result
  (`sinkPort: 0` bound 43235, `-1` bound 38983, `NaN` bound 37299, `70000` silently
  became 65535) through the seam `types.ts` documents as *the* way a second instance
  gets its own port. A guard that covers one source of a value is not a guard on the
  value. The env var is now also registered in `config/index.ts` — deliberately as a
  raw knob rather than an `intKnob`, because every other numeric knob has a constant
  default and this one's default is derived, so the only fallback an `intKnob` could
  declare is 0, the single value this knob must never accept.

  THE TOKEN loader mirrors `open/persisted-secret.ts`, which cannot be imported here
  (`.dependency-cruiser.cjs`'s `nobody-imports-composition` forbids anything outside
  `^open`/`^gateway` from importing `^open`): read through an `O_NOFOLLOW`
  descriptor, `fstat` THAT fd (a regular file with NO GROUP OR OTHER ACCESS —
  `(mode & 0o077) === 0`, which is the security invariant; 0400, 0500 and 0700 are
  therefore ACCEPTED and used as they are), read the bytes from the same fd so there
  is no TOCTOU window.

  THAT PREDICATE WAS `mode !== 0o600` FOR ONE ROUND, and an earlier version of this
  very paragraph argued for the equality. Both were wrong, and the correction is
  recorded here rather than quietly dropped: equality on a permission mask also
  refuses files that are STRICTER than demanded, which has no security value and
  costs everything on a boot path. POSIX applies the umask to the create mode, so
  `umask 0277` produces a 0400 token — safer than asked for, and refused: on the
  create path the sink then threw and never started, and on the read path it silently
  re-minted a token that had never been exposed, stranding every child baked with it.
  An operator with a hardened umask is not a threat model, and provenance is not
  something a mode can establish anyway (an attacker who can write the directory can
  write 0600). `fchmod` on the held fd normalises what WE write to 0600 whatever the
  umask; the ACCEPTANCE rule stays the invariant.

  Published by `link` — see the concurrency section below. A symlinked, non-regular,
  group/other-accessible, empty, whitespace or short token file is refused and
  re-minted, with the reason and the consequence on stderr, and a staging file left
  by a killed process is swept on the create path (bounded, our prefix only, and never a
  racer's live staging file).
  Its header states plainly what persistence WIDENS: the token is no longer worth
  one process lifetime but every lifetime until the file is removed — AND that this
  is a new exposure in KIND, not just duration. A per-process token was revoked by
  every restart, so a `claude` orphaned by a previous incarnation could not be
  believed by the next gateway. A stable one is not revoked, and at the time this
  was written the sink answered `/tool-call` and `/activity` before the no-session 404,
  so an orphan holding the token reached the live tool bridge with a fabricated session
  id and no live turn behind it (measured then on a bridgeless instance: 503 "no tool
  bridge wired" / "no-tap", i.e. past the token check).

  **That argument was accepted and acted on in the same PR, so this paragraph is
  history, not current state.** The per-session token it calls for is no longer
  deferred: `spawn.ts` hands each child `HMAC(root, childGeneration)` and the sink
  authorizes credential -> session, so a fabricated session id buys nothing and an
  orphan's credential belongs to a dead incarnation. The residual that survives is
  narrower and is stated separately below: same-uid read access to the child's own
  0600 config still defeats it.

- **`runtime/adapters/claude-code/persistent/pool-state.ts`.** `ReplSink` is
  exported (a second instance is how restart survival is testable), takes a
  `ReplSinkConfig` (`port`, `tokenPath`, and the two bind budgets), resolves its
  token lazily through `loadOrCreateSinkToken` — lazily because the module
  singleton is constructed at import time, before any caller has said which
  instance it belongs to — and binds the RESOLVED port (the per-instance derivation
  unless an override was given) with a bounded retry (`SINK_BIND_ATTEMPTS = 5` ×
  `SINK_BIND_RETRY_DELAY_MS = 150`) for the overlap window of a restarting gateway. **EADDRINUSE never
  falls back to an ephemeral port**: it throws, naming the port, what is probably holding it, and the two
  ways to give this instance a port of its own. A silent fallback would reintroduce
  #537 invisibly, one spawn at a time.
  `stop()` is new (the token is kept — it is on disk and every child holds it), and
  the bound port is recorded at bind time because `Bun.serve`'s `.port` reverts to
  0 once stopped. A configuration that arrives after the coordinates are fixed
  (two instances in one process) loses to the live values — they are already baked
  into live children — and says so on stderr rather than diverging quietly.
  **`ensureStarted` is ASYNC and the retry wait is `await Bun.sleep`** — the mechanism
  `persistence/retry.ts` requires, not a blocking wait inside a budget. This paragraph
  said the opposite for several rounds ("synchronous by contract, so the wait must
  block, ~30 call sites, none awaiting"), which described the FIRST design and was
  never re-read when the code moved — the drift this document exists to prevent, so it
  is corrected here rather than trimmed out. What ships: `async ensureStarted(config):
  Promise<void>`; concurrent callers share ONE attempt through an in-flight promise, so
  a second caller can never see its own process's healthy listener as EADDRINUSE; and
  the two call sites are `spawnSession` (already async) plus the test-only
  `getReplSinkInfo`, with the ~20 synchronous fake `PtyHost.spawn` bodies reading an
  already-started sink through `getStartedReplSinkInfo()` instead of awaiting.

- **`runtime/adapters/claude-code/index.ts`.** `ReplSupervisionPaths` gains
  `sinkTokenPath` (`<home>/.neutron/.sink-token`) and the supervision block wires
  `p.sinkTokenPath`, so every durable REPL path still comes from one function and
  the token lands in the state dir — outside every working tree.

- **`runtime/adapters/claude-code/persistent/types.ts`.** `sinkTokenPath` and
  `sinkPort` on `PersistentReplSubstrateOptions`, documented in the same family as
  `replRegistryPath`.

- **`runtime/adapters/claude-code/persistent/spawn.ts`.** `sink.ensureStarted()`
  now passes those options through. The two BAKING call sites are untouched by
  design — they read `sink.port` / `sink.token` exactly as before; the point is
  that those values are now stable. The 2026-07-20 adversarial-review note on the
  0700 config dir / 0600 files is re-examined in place: its reasoning gets
  stronger under a persisted token, nothing is relaxed, and the widened window is
  named where the token is loaded.

- **`runtime/adapters/claude-code/persistent/repl-sink.ts`.** `getReplSinkInfo()`
  is unchanged in shape; its docblock now says the coordinates it returns are
  durable.

### The async fix opened a window, and closed it

Making the retry asynchronous was right and it created a race the synchronous
version could not have: `Bun.sleepSync` never yielded, so no second caller could
interleave, but `await Bun.sleep` lets two `spawnSession`s sit in the retry loop
together. `this.server` was only checked BEFORE the loop, so the moment one caller
bound the port the other's next attempt saw ITS OWN process's healthy listener as
EADDRINUSE, exhausted its budget and rejected — reporting the fatal, non-retryable
`channel_wedged` added in the same round while the singleton sink was perfectly
fine.

Startup is now serialised behind a single in-flight promise: the first caller runs
the start, every concurrent caller awaits THAT promise and inherits its outcome,
success or failure. That is the shape `pool.ts` already uses for
`Promise<ReplSession>` and `pendingChildKills`, and deliberately NOT the boolean
`InFlightGate`, whose loser SKIPS — a caller that skipped would return with no sink
started, which is the opposite of what it asked for. With startup serialised,
nothing else in the process can bind the port mid-loop, so the loop needs no
re-check; adding one would be a branch no test could reach, and this file does not
pretend those are guards.

### The question this PR kept getting wrong: what does refusing a SAFE state cost?

Four times in this change a guard or a read was correct about the thing it named
and wrong about the thing it decided. They are worth listing together, because the
shared shape is the lesson and not any one of them:

1. a staging name built from `pid` + a per-process counter — correct that staging
   names must not collide, wrong that a dead process's leftover name is a collision.
   The result was `EEXIST` on a fresh boot: a crash remnant blocking the restart
   this module exists to make survivable.
2. `perms !== 0o600` — correct that a token must not be group/world accessible,
   wrong that "not exactly 0600" means "not safe". POSIX applies the umask to the
   create mode, so `umask 0277` yields 0400: STRICTER than demanded, and refused.
   On the create path that threw and the sink never started; on the read path it
   silently re-minted a token that had never been exposed, stranding every child
   baked with it.
3. `resolveSinkPort` reading `process.env` — correct that the operator's knob must
   be honoured, wrong that reading it again is how to honour it. `resolveBootConfig`
   had already resolved and validated it, so an INJECTED config was inert and a
   stale process variable silently won.
4. (earlier) falling back to `port: 0` on `EADDRINUSE` — correct that a gateway
   should start if it can, wrong that any port will do.

The transferable question is not "is this check right?" but **"what safe state does
this check refuse, and what does refusing cost?"** On a boot path the cost of
refusing a safe state is total — the gateway does not start — while the cost of
accepting an unsafe one is exactly what the check is for. Both errors are real; only
one of them was being weighed. Each fix here therefore pairs its refusal with the
adjacent case that must still be ACCEPTED (0644 refused / 0400 accepted and left
alone; a colliding name refused / a dead process's remnant tolerated; an invalid
override refused / an absent one leaving the derivation in place), because a check
that refuses everything passes a test that only feeds it the unsafe case.

### The operator's port knob is resolved ONCE and wired, not read twice

`resolveBootConfig()` validates `NEUTRON_REPL_SINK_PORT` into
`BootConfig.replSinkPort`, and `composeProductionGraph` now hands it to
`setReplSinkPortOverride` beside the other process-level sink singletons
(`setReplToolBridge` / `setReplTodoSync` / `setReplActivityTap` — the fourth instance
of that late-bound pattern, for the same reason: the value lives in the boot
configuration and the consumer is a leaf that must not read the environment a second
time). `resolveSinkPort`'s precedence is the per-substrate option, then that wired
override, then the per-instance derivation — and there is NO env fallback, because a
fallback that wins when the caller forgot to pass the value is how two paths stay
divergent. An injected config is authoritative: when an entrypoint threaded one, the
composer does not consult `env` at all.

The test boots the REAL composer with a config resolved from an env BAG while the
process variable is CLEARED, and asks the runtime what port it would bind — the
defect was that nobody CALLED the setter, which no unit test of the setter can catch.
Its paired case asserts that a config WITHOUT the knob leaves the derivation alone,
so the wiring cannot latch a value for the process.

### Derived where it must be, RANDOM where it must be — they are not the same rule

Two values in this change look contradictory at a glance, and the next reader will
otherwise "fix" one of them, so both the code and this record say it plainly:

- the **port** must be DETERMINISTIC and the **token** must be STABLE, which are not
  the same property and the difference is the whole mechanism. The port is *derived*
  — `deriveSinkPort(stateDir)`, a hash of the state dir, so the next gateway computes
  the same number from the same input with nothing stored. The token is *random*:
  `stageFreshToken` mints it with `randomBytes` and restart stability comes from
  PERSISTING that value to a 0600 file, not from recomputing it. Calling both
  "deterministic" reads as though the token could be re-derived, which would mean a
  secret computable by anyone who knows the inputs — the opposite of what it is.
  Either way a child baked with them still authenticates after a restart, and that IS
  #537.
- the **staging temp name** must be UNIQUE. Nothing ever reads it by name; its only
  requirement is that two writers never choose the same path.

Determinism is the requirement in one place and the defect in the other. The
staging name was built from `process.pid` plus a counter that restarted at 1 in
every process, which a review caught as a boot-blocker: a process killed between the
`openSync` and the publish leaves `.sink-token.<pid>.1.tmp` behind, and the next
process handed that PID inside the sweep's 60 s window picks the SAME name, takes
`EEXIST` from `O_EXCL`, and throws — so the sink never starts. A crash remnant
preventing the restart this whole change exists to make survivable, which is the
failure mode rather than an edge case. It is now `pid + 8 random bytes`: the class is
deleted rather than retried around (a retry loop would leave the same race one
iteration wider), and `O_EXCL` goes back to guarding a genuine concurrent staging
attempt. The PID stays in the name only so an operator can see who left an orphan.

Two tests, because one assertion could not cover both halves. The reviewer's repro
runs in a FRESH SUBPROCESS — the only place the defect is reachable, since the
counter restarts per process: the child plants the remnant under its own PID, too
young for the sweep, then mints, and must not throw. (Written in-process first, it
passed against the deterministic scheme too, because earlier tests in the file had
already advanced the module counter past the planted name; the mutation check is what
said so.) And the uniqueness CONTRACT is asserted directly on the name builder,
because a constant-but-unique-looking suffix — a fixed string, or one random value
chosen once per process — satisfies the remnant test while reintroducing exactly the
collision. Mutations: the old pid+counter shape reds the subprocess test; a constant
suffix and a once-per-process random suffix each red the contract test.

Same-signature audit across what this change introduced: one grep
(`process.pid` used to build a name) found this site as its positive control and no
other new one. The pre-existing neighbours it also finds — `runtime/atomic-write.ts`,
`runtime/entity-writer.ts`, `trident/orchestrator.ts`,
`persistent/ensure-claude-trust.ts` — open their staging files with `'w'` /
`writeFile`, which OVERWRITES a remnant instead of failing on it, so none of them can
block a boot. `open/persisted-secret.ts` does combine pid+counter with `O_EXCL`, but
its caller degrades to an ephemeral secret with a loud warn rather than throwing;
it is pre-existing and left alone here rather than smuggled into this change.

### A session id is an IDENTIFIER, not a credential — the durable-token finding one layer up

The registered-session gate from the previous round asked whether the id was KNOWN and
never WHOSE it was, and that is not a fix. Every child carried the same durable token,
and session ids are PUBLISHED to the process table by design: `--session-id` /
`--resume` is how resume works, and this tree's own orphan scanner parses exactly that
representation (`orphan-adoption.ts`). So an orphan holding the shared token could read
a live child's `/proc/<pid>/cmdline`, lift its id, and be authorized AS that child. The
PR's own title said an orphan must not; the mechanism said it could.

This is the sibling of the `O_NOFOLLOW` finding one section down: that check asked
where the open LANDED and never what it landed ON; this one asked whether the id was
known and never whose it was.

**Authorization now runs CREDENTIAL → SESSION.** Each child is handed
`HMAC(root token, childGeneration)` — derived by the sink so the value baked into the
child and the value the sink authorizes cannot drift — written only into its own 0700/0600
config, and the sink derives WHICH session a caller is from what it presents. The body's
`session_id` is advisory: it is the value an orphan can read, so it decides nothing.

Four properties, each load-bearing:

  - **Per child.** A child is handed only its own derived value, never the root, so it
    cannot compute a sibling's credential.
  - **Per INCARNATION.** `childGeneration` is a fresh UUID per spawn, and respawn reuses
    the SESSION ID — so a credential keyed on the id would stay valid for the
    REPLACEMENT child, which is precisely the orphan-from-a-previous-generation case.
    This is the property that is easy to miss and the one the respawn test exists for.
  - **Not guessable from the process table.** The generation is never on argv and never
    in the child's env.
  - **Recomputable, so nothing new is stored.** A restarted gateway holding the root plus
    the already-persisted `child_generation` re-derives exactly the credential a
    surviving child is still presenting — which is what lets #539's adoption
    re-establish authorization with NO new secret at rest. The restart criterion is now
    tested that way: the second sink instance derives the SAME credential for the same
    generation, and the child baked by the first is authorized by the second.

The root token keeps its purpose and loses its power: it is a KEY, not a bearer
credential. It authorizes nothing by itself, which is why
`getStartedReplSinkInfo()` — the accessor that handed tests the root so they could pose
as a child — is DELETED rather than renamed. Keeping it would be keeping the shape of
the hole. Tests standing in for a child now read what that child was actually given,
out of its own per-session MCP config (`bakedChildSinkInfo(argv)`), which is the same
path the real child takes; that is 24 files, mechanically, and it is the faithful shape
rather than a workaround.

`injectMessage` takes the SESSION rather than a port, for the same reason: the
gateway→child leg must present THAT child's credential, because the child validates the
inbound header against the `SINK_TOKEN` it was baked with.

WHAT THIS DOES NOT CLOSE is in the spec item in full: same-uid read access to the
child's 0700/0600 config defeats it (the exposure `spawn.ts`'s owner-only note already
states); and `SO_PEERCRED` — the strongest discriminator available, an externally
maintained handle the subject cannot rewrite — needs a UNIX SOCKET, while the sink is
loopback TCP, so there is nothing to read. I checked the transport rather than assuming
it: moving the sink to a unix socket would change the child's transport and both baking
call sites, which is a real option for a later item and not a free addition here.

### A durable token authenticates the CHANNEL; it must not authorize the ACTION

The sharpest finding of the change, and it is this PR's own thesis inverted rather
than a side issue. #537 exists to make the sink credential survive a restart — and
that durability is exactly what makes it dangerous, because a token nothing rotates
is a token an orphan holds forever. Before this change the credential died with the
process, so an orphaned `claude` was revoked by the restart for free and the absence
of a revocation mechanism cost nothing. The change removed the thing that was doing
the revoking and did not replace it.

`/tools`, `/tool-call` and `/activity` were answered BEFORE the session lookup, on
the reasoning that they dispatch against the process-global `ReplToolBridge` rather
than a per-session driver and carry no in-flight turn. True, and beside the point:
the bridge is the most privileged thing the sink can reach (`note`,
`dispatch_agent`, `reminders`, `project_*`), so an orphan holding a valid token
could fabricate a `session_id` and dispatch into a gateway that had never heard of
it. The earlier header for this file NAMED that exposure and accepted it; naming a
hazard is not the same as not shipping it.

Every route is now gated on a REGISTERED SESSION — the minimal change that restores
the narrowing a rotating credential used to provide. Nothing a live child needs is
refused: `spawnSession` constructs and registers the session BEFORE it spawns the
child, deliberately, so a child that exists has a registered session for its whole
life. What is refused is a call arriving after the session was unregistered: a dying,
evicted or orphaned child.

The rule the whole item turns on, stated once so the next reader does not have to
re-derive it: **you cannot make a credential longer-lived without making it
narrower.** Lifetime and scope trade against each other; this change extended one, so
it had to shrink the other.

Tests assert both directions, because the input a wrong implementation gets right is
not a foreign token — any token check rejects that — it is a VALID token with no live
session, on a privileged route. An orphan is refused on all three routes with nothing
dispatched or recorded; a live registered session with the SAME token still
dispatches both; and unregistering a session revokes it immediately, so reaping an
orphan is not cosmetic. Mutations: the pre-fix route ordering reds the denial cases,
and a guard that refuses everything reds the acceptance cases.

Eleven existing tests asserted the OLD contract — `/tool-call` with `session_id: 's'`,
`/activity` with `'no-such-session'` degrading to the General scope. They were
re-pointed at the new criterion rather than deleted: each now registers a live
session, keeps every behavioural claim it made, and the denial half moved to the
#537 boundary file. The `/activity` comment that argued "losing an activity row is
worse than mis-scoping one" is replaced by the reason that trade changed: a row from
an orphan is not a row worth keeping.

### Concurrent REPLACEMENT converges too — the same failure, one function over

Concurrent CREATION of an absent token was made winner-preserving with `link`;
REPLACEMENT of a present-but-invalid one quietly kept an unconditional `rename`, and
a review found the PR's own failure mode reachable through it: two processes finding
the same bad file both published, so the one that bound the port could hold token A
while the disk held token B — #537, on the restart-overlap path #537 exists to make
survivable. A documented residual is only honest when the scenario is incidental,
and two gateways overlapping IS the scenario.

Replacement is now: re-verify (adopt a competitor's token if one has appeared),
QUARANTINE the bad file under a unique name (`.rejected.<random>`, kept so an
operator can see what was refused and swept with the rest of our litter), then go
through the same `link` create-if-absent as creation — one winner, every loser
adopts. The value returned is always the value on disk.

What is NOT closed is stated in the code rather than implied: a re-read happens at a
moment and a writer can land after it, so if a second process re-verifies in the
instant before the first's `link` publishes, it will quarantine a good token and
publish its own. That window is a few syscalls wide and needs an already-invalid
token file plus a second process entering the same region within it. Closing it
entirely requires serialisation — `withFlockSync` does that wherever Bun's FFI
exists, which is every supported deployment — so the lock is defence in depth here
and NOT the correctness argument, because the steps above converge without it. The
re-verify step is honestly unprovable by mutation: removing it leaves the
four-process tests green, because the interleaving it narrows is sub-syscall. It is
labelled that way in the code, like the other two assertions in this change that are
belt rather than braces.

### One sink per process, and what the second home really gets

The new injection test went red in a 100-file CI shard while passing alone, and the
cause is a property this change documents but had not pinned: the sink is a PROCESS
SINGLETON whose coordinates are fixed by whichever call starts it. An earlier file
in the shard started it against its own instance home, so the test — which read
`defaultSinkTokenPath()` — compared the live token against a file the sink had never
used. The fix is not tolerance of either token (that would turn the assertion back
into a decoration, which is what it was written to replace) but a claim that holds
whatever started the sink: the token it PRESENTS equals the bytes in the token file
IT used, which is what any child of any incarnation was baked with. Proven faithful:
with a deliberate hostile neighbour that starts the singleton against a foreign home
first, the old assertion reds and the new one passes.

A second shard failure followed the first, for a second property of the same shared
process: the test then read the token file the singleton HAD used, and in that shard
the foreign test which started the sink had already deleted its temp home — ENOENT.
Both failures were the same mistake, not a logic error in the subject: the test was
reaching for state it does not own. It now owns ONE half and says which — the request
production actually makes (URL, method, content type, body, and that the token on the
wire is the sink's rather than anything per-turn) — while "the sink's token is the
persisted one" stays with the tests that round-trip a token file through two sink
instances. A composition of two proven claims is honest where one over-reaching
assertion is not. Both hostile-neighbour conditions were reproduced against the fix
(a foreign home, and a foreign home that is then removed).

The underlying constraint is now decided out loud rather than left implicit. A
second instance composed in the SAME process borrows the first's port and token:
that works for the life of the process and then does not — on the next start the
second instance derives its own port and reads its own token file, and the children
baked with the first's coordinates are unreachable. #537, scoped to a case #537 does
not fix. It is documented and warned about (once per distinct divergence, not once
per spawn) rather than refused, because production hosts one instance per process
and making a second home throw would fail a great many tests for something harmless
in-process; a process that genuinely hosts two instances needs a sink PER INSTANCE
keyed by state dir, the natural extension of the per-instance port. A test pins the
borrowing behaviour so a future change cannot alter which coordinates win silently.

### Assertions that measured a proxy instead of the claim

A cross-model pass found the gateway→child test satisfied in letter and not in
substance: it `fetch`ed a stand-in server directly and then leaned on a
SOURCE-TEXT assertion that `spawn.ts` contained a header string. Production
`injectMessage` could have changed its URL, method, body or token — or stopped
making the request — with both tests green. It now drives the real
`injectMessage` against a recording fake child and asserts what the child
RECEIVES: path `/message`, `POST`, `application/json`, the token read independently
off disk, and the exact body `{ text, turn_id, additional }`. Four mutations prove
it (no header, wrong token, body-shape drift, and the 401 control).

The same question — *what would have to break for this to go red, and is that the
criterion or a stand-in?* — was then put to every other assertion in the file, and
three more were rewritten:

- the token-placement test asserted `join(stateDir, FILENAME)`, which restates the
  implementation; it now asserts the token shares a directory with the REPL registry
  and the heartbeat and sits under the home, which is the actual criterion;
- the EADDRINUSE test asserted the message `toContain('repl-sink')`; it now asserts
  `classifySpawnError(msg) === 'channel_wedged'` and that the class is
  non-retryable, closing the loop between the producer's wording and the ladder's
  behaviour — a rename that broke the classifier would have left the old assertion
  green;
- the entropy assertions compared against `SINK_TOKEN_MIN_LEN`, the same constant
  the production predicate uses, so lowering it moved both; they now pin the minted
  shape absolutely (48 hex chars) with the floor pinned separately. Mutations: a
  16-byte mint reds, and lowering the floor reds.

### A bind failure is FATAL, and now says so

`classifySpawnError` had no branch for it, so `pool.ts` stamped the default
`retryable: true` with no code and the credential ladder would re-attempt a held
port forever. It is now `channel_wedged` — the class whose description is "failed
to spawn / bind its control channel", non-retryable — with the negative space
pinned too (a message that merely mentions the sink is still unclassified).

### What this change does NOT do, stated because the first draft overshot

Durable coordinates are a PRECONDITION for adopting a surviving REPL, not the
adoption. Nothing here re-registers a surviving REPL into the sink's session map,
and `pool.ts` needs an in-memory `session.channelPort` to inject, so a surviving
bridge's `/reply` is refused with **401**. That is #539's work, and
`sink-coordinates.ts` says so where it makes the claim.

This paragraph said 404 `no-session` until round 16, and that was the pre-credential
design: when every child carried the shared root token, a survivor authenticated and
then failed to route. Authorization now runs CREDENTIAL -> SESSION and the lookup
precedes any session lookup, so the survivor never reaches the routing step. Measured
rather than reasoned: there is no `no-session` response left in the adapter (the only
`no-session*` is `no-session-to-resume`, a 409 in `session-respawn.ts`), the sole 404
in `pool-state.ts` is the unknown-path catch-all, and the restart-survival suite
asserts no 404 at all. The claim that "the test asserts exactly that 404" was true when
written and had outlived the code by one round.

### Concurrent first startup — the second P1 the review caught

Port exclusivity orders the SOCKET, never the file. The token is resolved BEFORE
the bind, so two processes starting at once are both in the token path and only one
of them goes on to hold the port. The first revision published the minted token
with an unconditional `rename`, which always "succeeds" — so A could publish token
A and win the bind while B published token B and lost it, leaving the LIVE gateway
authenticating with a secret the disk did not hold. The next restart would then
hand B to children baked with A: the precise failure this change exists to close,
reachable on a first boot. The header of `sink-coordinates.ts` had argued no lock
was needed *because* the port was exclusive; that argument is now written down as
wrong, where it was made.

Two independent mechanisms, deliberately redundant:

1. **`registry-lock.ts`'s `withFlockSync`** — the `flock(2)` helper that already
   lives in this directory, reused rather than reinvented, on a sibling
   `.sink-token.lock`. Only one process is in the create/replace region; the others
   re-read INSIDE the lock and adopt. It degrades to unguarded when Bun's FFI is
   absent, which is exactly why it is not the only mechanism.
2. **`link`-based publish** (`createTokenIfAbsent`) — `link(tmp, path)` publishes in
   one atomic syscall that FAILS with `EEXIST` if the name is taken, so a race has
   exactly one winner and every loser re-reads and adopts. It needs no lock at all,
   which is why concurrent CREATION converges unconditionally.
   `rename` survives in two places only, and neither clobbers the destination: it
   moves a STAGED file into a name that is absent, and it moves an UNTRUSTED file
   ASIDE into a unique quarantine name. An earlier revision did use it to publish a
   replacement over the destination — see the replacement section below for why that
   was this PR's own failure mode and what replaced it.

The fast path — an existing, trustworthy token — still takes no lock and writes
nothing.

### The guarantee is stated WITH its condition, and the weaker mode says so

The replacement convergence above holds while the advisory lock is held, and
`withFlockSync` runs UNGUARDED when Bun's FFI is missing (and after a nonzero
`flock`, which it already logs). The code said that; the spec item did not — it
promised convergence unconditionally, which is the claim/instrument mismatch with the
roles reversed: an honest implementation under a criterion that over-promises. The
criterion is now two, with the condition in the text of the second, and a third for
the degradation.

Failing closed was considered and rejected, and the reason belongs in the record:
where FFI is missing it is missing ALWAYS, so a replacement that refused to proceed
without a lock would mean an instance whose token file is invalid can never start —
the boot-blocker class this change has already had to fix twice. The cure is worse.

So instead the weaker mode is made VISIBLE. `registry-lock.ts` gains
`flockAvailable()`, the token loader takes its lock as a self-describing dependency
(`{ available, run }`), and when `available` is false it writes ONE line naming not
"no lock" but the consequence: a concurrent replacement can leave this gateway
holding a token the file does not, so a restart hands surviving REPLs a secret they
do not have. That injectable lock is also the only way to REACH the unlocked branch
on a host where FFI works, which is what makes the boundary testable at all.

NEITHER DIRECTION DEPENDS ON THE HOST, which took one more correction. The locked
case first asserted `flockAvailable() === true` — a precondition that would fail on
exactly the host the unlocked path exists for, before it could reach that path: the
suite refusing the configuration the round was about. It now INJECTS a lock that
genuinely serialises across processes from POSIX primitives alone (`O_EXCL` create as
the mutex, bounded spin, unlink on release), so "it converged under serialisation"
means the same thing everywhere, and the four-species replacement cases inject it too.
The four-process CREATION case deliberately keeps the ambient default and says so,
because creation converges with no serialisation at all. The native `withFlockSync`
path stays covered by every single-process case, none of which passes a lock. A
mutation that makes the loader IGNORE its injected lock reds the flock wiring pin, so
the seam is load-bearing rather than decorative.

Both directions are tested: the unlocked path must warn (once, per process that
actually entered the region — a racer that arrives late takes the lock-free fast path
and correctly says nothing, which an earlier version of this assertion got wrong and
the full-file run caught), and its outcome must still be BOUNDED — every process
returns a token that was PUBLISHED at the destination, never a private mint no reader
could have seen, which is the real difference between "narrow window" and "anything
can happen". The locked path must converge AND stay silent, which is what stops the
warning assertion from being satisfied by a line that always fires. Mutations: the
warning removed reds the unlocked case; the warning made unconditional reds the
locked case. The one line no test on this host can reach is
`defaultSinkTokenLock()`'s own `available: flockAvailable()` — on an FFI-capable box
it is always true — and that is reported rather than dressed with a test.

### A validation downstream of an operation the invalid input can block

The fourth boot-blocker class here, and the cleanest statement of the shape: the
token reader rejected a non-regular file by `fstat`-ing the fd — AFTER opening it. A
FIFO at the token path blocks `openSync(O_RDONLY)` until a writer appears, so the
`isFile()` rejection was unreachable for the one input it was written for, and the
gateway hung at startup rather than re-minting. Measured on the unpatched tree: the
process never returned, and a JS watchdog could not rescue it either, because the
blocking open pins the thread.

Fixed by adding `O_NONBLOCK` to the read open, which makes the type check reachable
for every non-regular type at once — and ADDED to the existing flags rather than
replacing them, because `O_NOFOLLOW` plus `fstat` on the SAME fd is what defeats a
symlink swap and that property must not be traded away for this one. Worth recording
why the original pattern did not already cover it: `O_NOFOLLOW` + same-fd `fstat` is
the right answer to a symlink swap, which is the threat modelled in round 1 and
modelled well — it asks where the open LANDED and never what it landed ON. **A threat
model that is correct is not thereby complete.**

The same blocking shape was one file over, on a path this change introduced:
`withFlockSync`'s `openSync(lockPath, 'w')` blocks on a FIFO until a READER appears,
and the sink's lock path is derived by this module, so leaving it would have been
leaving our own boot-blocker. It carries `O_NONBLOCK` now too — nothing changes for a
regular file, and `flock` blocks on the LOCK rather than the fd, so the serialisation
is untouched.

Tests: FIFO, directory and socket, each in a SUBPROCESS under a hard deadline so a
hang fails as a hang (it does — "the child HUNG — killed after 15000ms"), each
asserting the REASON the operator is told rather than only that something was
replaced. That last part is why the type check is a guard at all: asserting only the
outcome left `isFile()` deletable, because the later read fails anyway (EAGAIN for the
FIFO, EISDIR for the directory) and the file is replaced for a different reason. A
char/block device is not covered because creating one needs privileges the suite does
not have, and that is stated rather than papered over.

Two construction errors in those tests, recorded because they are the same family as
everything else in this record: the socket case first called `server.stop(true)`
immediately, which UNLINKS the socket — so the child found an ABSENT path, minted
happily, and the case passed while testing nothing; and once that was fixed, the same
teardown ran BEFORE the assertions and deleted the freshly minted token the
assertions were about. Both were caught by the assertions failing for the wrong
reason, which is the only reason they were caught at all.

### A capability flag standing in for a held lock — the three-state family again

The observability built for the unlocked path covered "FFI is missing" and not "FFI
is present and acquisition failed", which is the case where a host looks fully
capable and silently is not. `flockAvailable()` answers whether the LIBRARY LOADED;
`withFlockSync` logs a nonzero `flock` and then deliberately runs the body unguarded
anyway, so the seam's `available: flockAvailable()` advertised a failed acquisition as
successful locking and no warning fired. The domain has three states — acquired,
available-but-not-acquired, unavailable — and a two-valued capability flag can only
carry two of them; "the library loaded" was standing in for "the lock is held", and
those differ exactly when it matters.

Fixed at the SEAM rather than at the warning: `withFlockSync` gains an `onOutcome`
report (additive, so its other callers are untouched — and the generic helper still
decides nothing, which is the same argument as putting the warning in the sink rather
than in the lock: it reports the fact and the caller rules), and `SinkTokenLock.run`
returns `{ acquired, value }`. The two failing states then collapse into the one thing
the caller must act on — the region was not serialised — and the warning fires on
that fact rather than on a proxy for it. It fires AFTER the region, because that is
when the answer exists; a region that threw reports nothing and the caller has an
error instead of a token, which is louder than any warning.

Mutations: warning on capability instead of acquisition (1 red, the unacquired case);
the report hardcoded to `false` (1 red, the positive control that exists for exactly
this). The report hardcoded to `TRUE` stays green and is reported rather than dressed:
distinguishing it needs a host where `flock` fails, which no test here can produce.
What improved is that the untestable thing is now one hop further from the behaviour —
before, the WARNING's condition was wrong on a real host; now only the fact-reporting
itself could lie, and its false direction is pinned.

### A comment that correctly described a defect, left in place after the fix

The fourth variety of stale documentation this change produced, and the most
persuasive one: not a lagging number, not a superseded design, not an exemption
dressed as a contract, but a comment that was RIGHT about a real hole — it is how the
P0 was discoverable at all — and then stayed after the hole was closed. The
`sink-coordinates.ts` header still said `/tool-call` and `/activity` are answered
BEFORE the session lookup, in a header whose job is stating the current posture, so a
reader trusting it concludes the gate is absent and either re-fixes it or builds on
the assumption those routes are unauthenticated. The more accurate such a comment was,
the more convincing it is once it is wrong.

It was corrected then to say the token authenticates the CHANNEL and a registered
session authorizes the ACTION, keeping the durable reasoning — a per-process token was
revoked by every restart and a durable one is not, so the credential had to be narrowed
as it was lengthened — and keeping what was then still OPEN: the sink checked that a
caller named a session it drives, not that it named its OWN.

**And then this very section went stale, in the round that closed that gap.** The
credential -> session change made the corrected header wrong again: authorization is no
longer "a registered session authorizes the action", the body's `session_id` is
advisory, and the open gap the paragraph carefully preserved had been closed by the same
PR. A cross-model round caught it — the header still describing the session-id gate as
current and the per-session token as future work, and *this record asserting the header
had been fixed*. So the species has a fifth variety and it is the sharpest one: **a
record of a correction, outliving the correction it records.** The claim "it now states
X" is a claim about the tree at a moment, and it decays exactly like the comment it was
written to fix — with the extra cost that a reader checking whether the documentation is
current finds a note saying it was already checked.

The header now describes credential -> session, and the still-open clause names the
residual that actually survives (same-uid read access to the child's own 0600 config),
not one that was closed. The
same sweep found one more of the species in code — `createTokenIfAbsent`'s header
still said `rename` was "still right for REPLACING an untrusted file, where clobbering
is the point", which the quarantine publish had already made false.

### The acceptance was met by the test performing the adoption production does not

The headline criterion said a request carrying the first instance's token is accepted
by the second. It passed. It passed because the test's credential helper,
`credentialOn(second, generation)`, **registers a session as a side effect** before
returning the credential — so the line asserting acceptance was measuring a sink that
had just been handed the very state the restart is supposed to be about. Production
registers nothing on restart; a survivor is refused 401.

Three instances of one shape have now been found on this branch, which is what makes
it worth a section rather than a bullet:

1. the respawn test called `unregisterIf` before registering a replacement, walking
   around the production path where nothing does;
2. the composition stub did not answer `ls-files --unmerged`, so it silently returned
   the one-sided branch instead of the state under test;
3. this helper registered a session while being asked only to derive a credential.

**A fixture that performs the step under test converts a missing implementation into a
passing test, and it does it silently** — nothing is asserted falsely, the arrangement
is simply richer than production's. The tell in all three is a helper doing more than
its name says: `credentialOn` derives *and registers*, and only the first verb is in
the name.

The criterion is now scoped to what this item actually delivers — reproducible
coordinates, with the credential re-derived through `deriveChildSinkToken` and no
registration on the way — and the 401 is asserted rather than avoided, with the paired
acceptance kept so the refusal cannot be met by a sink that refuses everything. Which
is the honest statement of #537: durable coordinates make adoption possible; they are
not adoption. #539 must RE-REGISTER a survivor, not merely reconnect to it.

### The acquisition report was asserted against a proxy, not driven

`withFlockSync` reports `acquired: false` for two states — FFI missing, and `flock`
returning nonzero — and that report is what raises the degraded-concurrency warning.
The seam test asserted `observed.acquired === flockAvailable()`, which on any
FFI-capable host is `true === true`. **Hardcode the production report to `true` and
that test still passes**, while production would silently stop warning that the lock
was not held.

The nonzero branch is not reachable by arrangement: on a valid descriptor `flock`
essentially only fails on EBADF/EINTR/ENOLCK, none of which a test can provoke. So the
syscall itself is now a settable reference (`setFlockImplForTests`), the same shape as
`sinkPortOverrideRef` — one reference the boot path never touches, not a second code
path: production reads the same line either way. The unlock goes through it too, so a
forced-failure test cannot leave a real lock held.

Mutation: `onOutcome?.(rc === 0)` → `onOutcome?.(true)` now reds exactly the new case,
52 pass / 1 fail. Before it, that mutation was invisible.

The general shape, and it is the third time on this branch: **an assertion comparing
the thing under test to a value that is equal to it on this host is not a measurement.**
`acquired === flockAvailable()` is true by construction wherever the suite runs, the
same way `second.port === first.port` was true because the fixture supplied both, and
the same way the acceptance passed because the helper registered a session. Each time
the fix was to assert against something the code does not get to choose.

### Making registration grant a credential moved a leak I had to go and close

`spawnSession` registered the session ~200 lines before it spawned. That was harmless
when registration was a session-id entry and the id was worthless on its own. This
change makes registration grant a CREDENTIAL — so every throw in between (config
writes, argv assembly, env merge) now stranded a standing authorization with no process
behind it, and left the config carrying that credential in plaintext on disk.

**A narrowing can create a leak somewhere else.** The credential is strictly better than
what it replaced, and it moved the failure mode rather than removing it, because the
lifetime of the grant was never the thing being reasoned about at the registration site.

Registration now sits in the smallest window that works — the statement before the
spawn, since the child can POST the moment it starts and an unregistered credential
would be refused — and the spawn is guarded: on a throw, `unregisterIf` (not
`unregister`, so a concurrent respawn already holding the id is not evicted by our
failure) plus `unlinkSessionConfigs`, then rethrow.

The test is the gate's own repro and it is effect-based: a host that captures `argv`,
reads `SINK_TOKEN` out of the real `--mcp-config` it was handed, and then throws. After
the turn drains, the config is gone and that credential gets 401 from the live sink.
Reading the token before the throw is load-bearing — the cleanup deletes the file it
comes from. Both halves mutated separately, each reds on its own.

### The lock this change introduced was not held to the standard the token was

`readSinkToken` was given `O_NOFOLLOW` and a same-fd `fstat` because a token path is
caller-supplied and may sit where someone else writes. The *lock* that arrived beside
it, in this same PR, got neither — `withFlockSync` opened it
`O_WRONLY|O_CREAT|O_TRUNC|O_NONBLOCK`. `O_TRUNC` applies AT OPEN, so a lock path that is
a symlink destroyed whatever it pointed at before the function had done anything, and
nothing downstream could notice. The threat model was correct and it simply did not
reach the sibling the change added — the same shape as `O_NOFOLLOW` + `fstat` asking
where the open LANDED rather than what it landed ON, one file over.

Both halves are now there and both are mutation-checked **separately**, which is the
part worth recording:

| mutation | result |
|---|---|
| drop `O_NOFOLLOW` | symlink case reds — the victim file is truncated |
| drop the `fstat` regular-file check | **initially GREEN — nothing could see it** |

That second row is the finding inside the finding. Every other non-regular type fails
at `open` on its own: a FIFO and a socket answer ENXIO under `O_WRONLY|O_NONBLOCK`, a
directory answers EISDIR. So the type check had no case that reached it, and a check
nothing can falsify is believed rather than tested — exactly the state the earlier round
collapsed two flags into one for.

The case that falsifies it is `/dev/null`: it opens cleanly with the production flags,
`fstat` reports a character device, and without the check `flock` succeeds and the body
RUNS. It also needs no `CAP_MKNOD`, which is what makes it usable here at all — the
suite cannot create a device node, as the spec item's non-regular criterion now says
out loud instead of in a parenthetical. An existing device was the way past a privilege
the tests do not have.

### The acceptance lives in a spec item; the tests verify it

This section used to be headed "the test is the acceptance", which is exactly what
`docs/process/work-tracking.md` §3.3 forbids — criteria belong in the repo,
enforceably, because a test can be edited by the same change that breaks the
property it protects. There was no spec item for #537 at all, and that was not a
paperwork gap: the security behaviour below was KNOWINGLY ACCEPTED in this file's
own header, and there was no document where that acceptance had to be written as a
criterion and defended. It reached a reviewer instead.

`docs/spec-items/durable-reply-sink-coordinates.md` now carries both
boundaries — restart survival AND authorization — each bidirectional and each naming
the check that verifies it, with the index regenerated. What follows is what the
tests do.

`__tests__/sink-restart-survival.test.ts` (48 tests, counted on the final tree rather
than carried forward from the round that first wrote this line). The load-or-create
behaviour both ways, with the mode asserted by `statSync`: absent → created 0600;
**existing valid → returned unchanged**, twice, because a token that is only
stable on the second read is not stable; 0644 → refused and replaced; empty,
whitespace-only, short → refused and replaced; a symlink → replaced by a real
0600 file with the link's target left untouched.

The central case is written as a restart: start a sink, take its coordinates the
way a spawn would, stop it, start a second one against the same state dir, and
require the second to bind the SAME port, present the SAME token, and accept a
POST carrying the FIRST instance's credential. Until round 16 that acceptance read
"404 `no-session` = authenticated and routed", which belonged to the shared-token
design: authorization now runs CREDENTIAL -> SESSION, so what the second instance must
prove is that the SAME derived credential is still recognised once the session is
registered on it — a foreign credential gets 401, and an unregistered survivor gets 401
too, which is why the registration is part of the case rather than incidental to it.

EADDRINUSE is asserted to fail loudly AND to bind nothing else — `sink.port`
throws `not started`, so the test would fail against a silent ephemeral fallback,
which a "it threw" assertion would not. The retry's value is proved with a real
subprocess holding the port and exiting mid-wait, because a blocking wait means an
in-process holder could never let go — which is also the real shape: the process
that frees the port is the previous gateway.

One thing the gate caught rather than the author: `defaultSinkTokenPath()` reads
`NEUTRON_HOME` as its home of last resort, and
`tests/integration/identity-env-readers-registry.test.ts` requires every such file
to be registered with a note — and the note has to be true. The reader now trims
the PREDICATE and returns the value VERBATIM (a blank falls through to the temp
dir; a space-padded real home is used as spelled, because trimming the return
relocates it), which is the rule `config/index.ts` states for this family, and the
three cases are pinned in the same test file the registry row cites.

Three tests were added for the two review findings. `ensureStarted({ port: 0 })`
throws, binds nothing (`sink.port` still says `not started`) and leaves NO token
file — the validation runs before any observable act — and `resolveSinkPort` is
driven through both sources for 0, non-integers, out-of-range values and valid
overrides. The concurrency case is two real PROCESSES and then four, synchronised
on a spin barrier because `bun` startup skew is tens of milliseconds: four racers
minting the same absent token must all end up with the ON-DISK value, and in the
two-process variant that also races for the port, the one that BOUND it must hold
the persisted token. A third test pins that the create path runs inside the flock
helper.

The reverse direction is pinned too, which the original brief did not ask for:
`injectMessage` sends `X-Sink-Token: sink.token` to the CHILD, and the child
refuses a mismatch (`dev-channel-impl.ts`), so a per-process token broke
gateway→child as well as child→sink. A restarted sink now authenticates against a
stand-in child holding the token the first gateway baked, with a wrong token
refused as the control, plus a source pin on the header itself.

Mutations run, each reverted after (round 2 — the port was still box-global at this
point; later rounds derive it per instance): the create mode 0600→0644 (11 red), the
permissive-mode rejection (1 red), the length floor (3 red), load-or-create →
always mint (3 red), the then-fixed port → `port: 0` (4 red), EADDRINUSE → a silent
`port: 0` fallback (3 red), `O_NOFOLLOW` removed (1 red). The post-create mode
VERIFY is the one assertion no test can reach without a hostile filesystem — it is
belt-and-braces behind the create mode that M1 covers, and it is labelled as such
in the code rather than claimed as a guard.

Two more mutations for that reader: the blank predicate → a bare `??` (1 red, the
blank/whitespace case), and the verbatim return → a trimmed one (1 red, the
space-padded home).

For the two review fixes: dropping the option-side validation (`config.port ??
resolveSinkPort()`) reds the `port: 0` test; reverting BOTH concurrency mechanisms
(`link`→`rename` and the flock) reds the four-process convergence test and the lock
wiring pin. Each mechanism ALONE is not individually provable by these tests, and
that is reported rather than dressed up: with the lock reverted the convergence
tests stay green (the `link` publish carries it) and only the wiring pin reds; with
the publish reverted they stay green (the lock carries it). The redundancy is the
point — one covers a runtime without FFI, the other covers two rotators replacing
an untrusted file — and the two-process port variant is probabilistically, not
deterministically, sensitive to the mutation, which is why the four-process
convergence test exists.

Round-3 mutations, one per guard added for the adversarial findings, each reverted
after: the derivation ignoring its state dir (2 red), the resolver not using the
derivation (2 red), the option-side validation removed (3 red), `await Bun.sleep`
back to `Bun.sleepSync` (1 red — the in-process holder can only release if the wait
yields, so the test proves the loop is not pinned), the mode predicate back to
`& 0o077` (1 red), the staging sweep removed (1 red), the sweep made greedy enough
to eat a live racer's file (1 red), and the fatal classification removed (1 red).
The `confirmInstalled` assertions are labelled in the code as NOT guards, for the
same reason as before: no test can reach them without sabotaging the filesystem,
and the guarantee they restate comes from the create mode, which IS mutation-proved.

The three P0 reproductions were re-run against the fix rather than argued away:
`tool-bridge.test.ts` with 18537 held → 9 pass / 0 fail (was 1/8); the three
concurrent suites → 19/31/5 with 0 fail, twice (was 2/7/5 failing), matching
`origin/main`'s own numbers; and `NEUTRON_TEST_JOBS=4` over the whole persistent
directory → 0 fail.

Round-4 mutations, each reverted after: startup no longer shared (1 red — the
two-caller concurrency test), the production inject dropping its token header (1
red), sending a token that is not the persisted one (1 red), drifting the request
body shape (1 red), the token path leaving the durable-state family (1 red), the
loud bind message no longer classifying as fatal (1 red), a 16-byte mint (1 red),
and a lowered entropy floor (2 red).

Round-5 mutations, each reverted after: the composer not wiring the override (2 red),
the composer preferring `env` over an injected config (1 red), the resolver ignoring
the wired value (1 red), the setter unable to CLEAR (1 red), exact-mode equality on
the read path (1 red — the stricter-file acceptance case), exact-mode equality on the
create path with the `fchmod` removed (1 red — the umask subprocess), the `fchmod`
alone (1 red — the normalisation assertion), and the mode check removed entirely
(2 red — the refusal cases).

Round-6 mutations: replacement back to an unconditional `rename` (3 red — one per
invalid-token species), replacement returning the bytes it WROTE rather than the ones
on disk (3 red, same three), and the re-verify removed (GREEN, and reported as such:
it narrows a sub-syscall window that a four-process test cannot reliably reach).

Round-7 mutations: the pre-fix route ordering — privileged routes answered before the
session lookup — reds the orphan-denial case and the revocation case (2 red); a guard
that refuses every request reds the two acceptance cases (2 red). The second is the
one that matters: without it the first is satisfied by a sink that dispatches nothing
at all.

A correction from the same round, recorded because it changed the fix: "publish then
re-read" was ALREADY in place on the replacement path (`confirmInstalled` re-reads the
destination and returns those bytes) and it is NOT sufficient — a re-read happens at a
moment and a writer can land after it. The convergent shape is re-verify, quarantine
under a unique name, then `link` create-if-absent, which is creation's own
winner-preserving path. What remains is the residue of a compare-and-swap on a
filename, which POSIX does not offer.

Round-8 mutations: the unlocked warning removed (1 red — the unlocked case); the
warning made unconditional (1 red — the locked case, which is why that paired case
exists). `defaultSinkTokenLock` claiming `available: true` unconditionally stays GREEN
on this host and is reported, not papered over: no test on a box with working FFI can
distinguish it.

Round-9 mutations: the loader ignoring its injected lock reds the flock wiring pin
(1 red), which is what makes the injected-serialisation cases mean what they say.

Round-10 mutations: warning on capability rather than acquisition (1 red); the
acquisition report hardcoded false (1 red — the positive control); hardcoded true
(GREEN, reported: it needs a host where `flock` fails, which no test here can make).

Round-11 mutations: the blocking open restored (1 red — the FIFO case, failing as a
HANG after the 15 s deadline rather than as a quiet pass); the `isFile()` type check
removed (2 red — FIFO and directory, via the refusal REASON, which is the assertion
that makes that check load-bearing); and `O_NOFOLLOW` traded away for `O_NONBLOCK`
(3 red — every symlink case), which is the pairing that proves the new flag did not
cost the old property.

Round-12 mutations, one per case as required: the pre-fix check (shared root + any
registered id) reds 7 — including all three new cases and the restart criterion; the
credential keyed on the SESSION ID instead of the incarnation reds 3, including the
respawn case that only the incarnation binding catches; baking the ROOT into the child
again reds 116 across the persistent directory, because every fake host presents what
the child was given; and dropping the credential revocation in `unregister` reds the
immediate-revocation case.
