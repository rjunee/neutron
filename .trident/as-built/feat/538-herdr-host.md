## 2026-09-12 — herdr is the REPL container: HerdrHost replaces the in-process PTY, and the ring becomes a rendered screen

`bun-terminal-host.ts` is deleted. The `PtyHost` backend is now `herdr-host.ts`,
driving herdr's unix-socket API (`herdr-client.ts`, `herdr-protocol.ts`). No flag,
no dual path. This is step 2b of the cutover (ISSUES #538), on top of #537's
durable reply sink.

Everything below that describes herdr was measured against the live server on
2026-09-12 (herdr 0.8.2, **protocol 20**), not read off a document. Where I
measured something the work order asserted, I say so; where I took the order's word,
I say that too.

### The central design problem: what scopes a turn when the ring is a screen

herdr has no raw output stream. Of its 91 methods the only output-bearing
subscription is `pane.output_matched`, which needs a pattern registered in advance,
and `pane.output_changed` is unusable despite being declared in the schema: I sent
both forms and the server rejected both — `events.subscribe` with `invalid request:
unknown variant 'pane.output_changed'` (the error enumerates the 27 it does accept),
and `events.wait` with `unsupported_event_wait_match: "events.wait currently
supports pane agent status matches"`. The work order said "rejected by
`events.wait`"; the schema declares `pane_output_changed` in both `EventKind` and
`EventMatch`, so I checked rather than assumed. The order is right and the schema
over-declares. Either way nothing is built on it.

So `onData` had to be synthesized by polling `pane.read` and diffing. Two shapes
exist and they break opposite invariants — diff-append breaks the detector falling
edge (`output-scan.ts:210-213`: `if (!present) { st.latched = false }` — a cleared
menu appends nothing, so `present` never falls and every content detector becomes a
one-shot for the session), and snapshot-replace breaks `PtyRing.textSince`
(`pty-ring.ts:89-93` before this change), which scoped a turn by **character
count**. Snapshot-replace was the ruling, and it is the fix `spawn.ts:336` already
named — "the proper fix is substrate-level (a rendered-screen ring …)", inside the
KNOWN LIMITATION block at `spawn.ts:327-338`. (The work order cited `314-317`; the
tree had moved ~20 lines.)

**The `textSince` decision: the mark stops being a number and becomes a baseline
screen.**

A count cannot work here, and not marginally. An Ink TUI repaints constantly, so
any byte counter advances by a full screen per poll on a screen that did not change
— `textSince` would return the entire screen forever, which *is* the stale-banner
re-arm that per-turn scoping exists to prevent. The counter cannot distinguish "the
screen was redrawn" from "the program printed something", and that distinction is
the whole question.

So `PtyRing.mark()` returns an opaque `RingMark` carrying the screen as it read at
the turn boundary, and `textSince(mark)` is an **order-preserving multiset
difference**: walk the current screen top to bottom, emitting each line only once
the baseline's remaining count for that exact line is used up.

- **A multiset, not a set.** An identical line legitimately recurs. A credential
  banner on screen from turn 1 that turn 2 prints *again* appears twice now and once
  at the mark, so exactly one copy is new. A set difference suppresses it and blinds
  the detector — a false negative on the signal the scoping was added to catch. This
  is not hypothetical: mutating the multiset decrement away (M8 below) reddens the
  real end-to-end warm-session re-arm case in
  `auth-failure-classification.test.ts`, not merely a unit test.
- **Order-preserving.** The consumers (`spawn.ts:453`, `types.ts:113-116`) feed the
  result straight to `buildDetectorContext`, which applies a bottom-N line slice and
  the doc-quote guard. Both are positional; a bag of lines breaks them.
- **The mark carries the baseline rather than indexing into ring-side history.** A
  numeric mark plus retained snapshots would need either unbounded history or a
  stale-mark path with no honest answer — `textSince` returns `string`, so a stale
  mark could only fail open (the stale banner re-arms) or fail closed (the detector
  goes blind). Making the mark self-contained deletes that failure mode instead of
  choosing a side of it. Cost: `turnOutputMark` changes type from `number` to
  `RingMark` at four sites, all of which were already known.

This is **strictly stronger** than the byte count for the case that motivated
per-turn scoping: a line already on screen at the mark is excluded no matter how
little has been printed since, whereas the count only excluded it once enough bytes
had arrived to push it past the mark offset — which is exactly the limitation
`spawn.ts:327-338` documents. It is weaker in one scoped way, recorded rather than
hidden: a line that was on screen at the mark, scrolled off, and returned
byte-identical reads as not-new.

The class keeps the name `PtyRing` even though it is no longer a ring, because "the
ring" is the component's name across the issue, the docs and this repo's prose, and
renaming it would churn ten files while making every existing citation wrong. The
*methods* are named honestly instead — `replace`, not `append`; `mark`, not
`totalBytesAppended` — and the docstring states what the object now is.

### Three things the poll loop has to get right

Each is a case where a naive loop looks correct on a steady screen and is wrong in
production.

1. **Deliver only on CHANGE.** `lastDataAt` drives the 900 ms idle gate
   (`DEFAULT_IDLE_QUIET_MS`, `signatures.ts:124`) that `waitForReplIdle`
   (`spawn.ts:1128-1134`) runs before every inject from `pool.ts:553`. A loop firing
   per tick keeps `lastDataAt` permanently fresh, so the REPL never reads as idle
   and every inject waits out the defensive cap instead of the quiet window. This is
   also *why* the poll bound is ≤250 ms: `lastDataAt` only advances when a poll
   observes a change, so the interval is the resolution at which "still emitting"
   is observable at all. 250 ms leaves 3.6× margin inside 900 ms.
2. **A failed read is not an empty screen.** A pane vanishes on exit taking its
   output with it, so the ring is the only record of a dead REPL's last output. A
   read that ERRORS is dropped; a read that SUCCEEDS and is empty is delivered,
   because that is a genuinely cleared pane and the falling edge needs it. The
   distinction is the whole guard: `try { read } catch { deliver('') }` satisfies
   either case alone.
3. **Ask for `viewport_rows + wanted` lines.** Measured decisively: on a pane with
   three content lines under a 62-row viewport, `recent_unwrapped lines=10` returned
   **empty** (`truncated: true`) while `lines=200` returned all three. Blank
   viewport rows count toward `lines` before trimming. `wanted` is 200 =
   `DISCLAIMER_BOTTOM_N` (`signatures.ts:78`), the widest window any detector reads.

### What I measured versus what I took on the order's word

**Measured on the wire myself:** protocol 20 and the `pong` shape carrying it;
`pane.read` returns `revision: 0` always (inert, so the bridge mints its own poll
sequence); `pane.output_changed` rejected by both `events.subscribe` and
`events.wait`; `pane_exited` carries only `{type, pane_id, workspace_id}`; 91
methods; `LayoutNode` type `pane` carries `command: string[]`; **`layout.apply`
genuinely execs** — `pane.process_info` reported `shell_pid: 2686118` equal to
`foreground_processes[0].pid`, the argv's own `/bin/sh -c …`, with no shell wrapper;
the read cap is exactly **999 lines** (`lines=5000` on a pane that printed 1500
returned 999, `truncated: true`) — so the request is CLAMPED to it rather than sent
unconditionally as `viewport + wanted`: the two constraints stop being jointly
satisfiable at a viewport of `cap - wanted` = **799**, and at 800 an unclamped
request asks for 1,000, gets 999, and silently delivers 199 of the promised 200
content lines. The policy is clamp AND SAY SO — `herdrReadWindow.contentAllowance`
reports what the request can still carry (negative past the cap, which is a
different fact from zero) and the host warns once naming the shortfall. The original
bounds test used viewports of 24, 62 and the 120 fallback, all well below 799, so it
proved the total was under the cap only for the values it happened to pick; the
blank-row rule above; `ctrl-c` **rejected**
(`invalid_key: unsupported key ctrl-c`) while `enter`, `esc`, `escape`, `tab`,
`up`, `down`, `left`, `right`, `ctrl+c` and bare digits are accepted (`arrow_up`
and `ArrowUp` also rejected); `viewport_rows` is on `PaneInfo.scroll` via
`pane.get`.

**Two things I found that the order did not mention, both load-bearing:**

- **`layout.apply` REPLACES a tab and mints new ids.** A request naming `w6:t2` was
  answered with `tab_id: w6:t3` and a fresh pane id, the old tab gone and its label
  inherited. A host that assumed the tab or pane it asked for would be driving the
  wrong pane. The client reads `result.layout.root.pane_id` out of the reply, and a
  test asserts the id used for reads is one the host could not have guessed.
- **An unparseable request comes back with `id: ""`.** The server cannot say which
  request failed, so a client correlating purely by id would wait forever on the one
  malformed request — precisely the shape a protocol bump produces. A reply whose id
  matches nothing pending therefore fails every in-flight request.

**Taken on the order's word:** that `agent.start` shell-quotes argv and types it
into a running shell and that its `kind` is a compiled-in enum (not re-tested — the
schema confirms `kind: string` against a server-side enum, and `layout.apply`
measured good, so nothing rested on it); that `ctrl+c` delivers a real SIGINT (I
confirmed the key is accepted, not that a SIGINT arrived); that `send_text` never
submits (I did not type into a live prompt — the design converts this into a loud
refusal rather than relying on it silently).

### Where the herdr API cannot express what `PtyHost` promises

- **No exit codes, anywhere.** `pane.exited` carries no status. `exited` therefore
  resolves **`null`** — the interface's existing "terminated, no code" value — and
  crash-vs-recycle collapses entirely onto `wasKilledByUs`. `null` is not only the
  honest value, it is the only one that preserves behaviour: `spawn.ts:565` reads
  `!killedByUs && exitCode !== 0`, so `null` keeps a real crash classifying as a
  crash, while resolving `0` would route every crash to `unregister()` and blind the
  crashed-agent detector.

  **There is a FOURTH route to a terminal child, and it is not a child event at
  all: the transport dying.** `pane_exited`, `pane.close` and a vanished pane each
  say something about the process; a closed socket says nothing about it — what died
  is the channel we would learn through. The poll loop used to simply return when
  `client.isClosed()` went true, so `exited` never resolved, `hasExited()` stayed
  false, and the pool kept handing out a REPL it could no longer observe or drive.
  "I cannot observe the child" now reaches the SAME terminal handling as "the child
  exited" — on a pool that hands out live sessions there is no other safe answer —
  and `PtyChild.exitCause` (`'pane-exited'` / `'closed-by-us'` / `'pane-vanished'` /
  `'transport-lost'`) keeps the two from being confused, since `exited` cannot carry
  the distinction when every death resolves `null`. Terminal is not the same claim
  as "the process ended", and nothing may report it as one.

  **One consequence, stated because it is a judgement and not a deduction.** A
  transport loss is not `wasKilledByUs`, so `spawn.ts`'s classifier sees
  `!killedByUs && exitCode !== 0` and marks the record CRASHED — surfacing it to the
  crashed-agent detector. That over-claims slightly: the process may well still be
  running and we simply cannot see it. The alternative is to treat it as an
  intentional termination, which unregisters silently and loses the signal entirely
  — and a REPL that disappears without trace is the same family as the bug being
  fixed. Surfacing beats silence here, and `exitCause` is what stops "crashed" being
  read as "the process crashed". Refining supervision to consume `exitCause` and
  report transport loss as its own class is a separate change, deliberately not made
  here.

  **The exit-code half of that condition now carries no
  information at all**, and that is pinned twice: at the host
  (`herdr-no-exit-codes.test.ts` — a crash and a recycle produce the *same* exit
  value and are told apart only by `wasKilledByUs`) and end-to-end through the real
  spawn exit handler (two new `herdr shape` cases in
  `crashed-agent-real-exit.test.ts`: the same `null` with opposite verdicts). The
  code-0 case there is kept, annotated as a guard on the classifier rather than a
  shape production can still produce, because deleting it would leave that branch
  untested.
- **`pane.resize` cannot set cols × rows.** It takes `{direction, amount}` — it
  nudges a split ratio; herdr's layout engine owns pane geometry and there is no
  cols × rows setter in the API. `PtyChild.resize` is therefore **optional** (the
  `writeKey?` / `wasKilledByUs?` pattern already in this interface) and `HerdrHost`
  does not implement it. It has **zero production callers** — the only `.resize(`
  in the repo was `bun-terminal-host.ts`'s own internal call, and the same grep
  finds that hit, so the absence is a real absence and not a broken grep. Nothing
  is narrowed. `PtySpawnOpts.cols`/`rows` are documented as advisory and ignored.
- **`send_text` never submits.** Rather than leave a silent no-op, `write()`
  **refuses** data containing `\r` or `\n` and names `writeKey('enter')` in the
  error; `writeKey`/`writeKeys` are the honest sibling that does submit, and the
  same test shows it working. The three production call sites send text then an
  `enter` key (`pool.ts`, `context-reset.ts`, `session-size-watchdog.ts`), and their
  tests require the **pair** — a `/clear` or `/compact` with no following `enter` is
  a command typed at a prompt and never run, so counting the text write alone would
  have kept passing while the feature was dead.

  **CORRECTED (review r2).** An earlier draft of this record claimed the pair was
  already sent at every production call site. It was not. Two of the three wrote
  `child.writeKey?.('enter')` — OPTIONALLY CHAINED, because `writeKey` is optional on
  `PtyChild`. For a child implementing `write` but not `writeKey` (a legal
  `PtyChild`) that typed `/clear` at the prompt, SKIPPED the submit, and returned
  `{status:'reset'}`: a reset that did not happen, reported as one.

  Worth recording rather than just fixing, because **I had already found this exact
  trap from the other side.** The `sendKey`/`sendKeys` byte fallback writes
  `encodeKey('enter')` = `\r`, which this backend's `write()` refuses — pinned with
  M24 and written up above as "one latent trap found on the way out". I fixed the
  path that would THROW and left the path that silently SKIPS, which is strictly
  worse because it reports success. **`?.` on a method whose absence changes the
  OUTCOME is a silent skip wearing the clothes of a safe default**, and having just
  reasoned about the throwing twin did not make me look at the optional-chained one.
  Submission is now mandatory: `submitCommand` (`signatures.ts`) refuses when the
  structured-key seam is absent, and `actuateSessionContextReset` turns that into
  `{status:'failed', detail}` — the honest sibling of the success it used to report.
- **`kill(signal)` has one real signal.** SIGINT maps to `ctrl+c`; anything else
  means "end this process", which only `pane.close` can do.

### One interface change beyond what the order specified, and why

**`PtyHost.spawn` is now `async`.** Creating the terminal is a socket round trip, so
the child's `pid` cannot exist when `spawn` returns — and `spawn.ts:504` reads
`child.pid` synchronously, feeding it into the live-process registry. `pid` is
load-bearing above the host: `supervision.ts:997-1003` probes it with
`process.kill(pid, 0)` and `supervision.ts:415-417` with `isPidAlive`, and the
crashed-agent registry keys entries on `(name, pid)`. The alternatives were to hand
back a child whose `pid` reads 0 for a window (a wrong pid registered permanently,
which is the silent narrowing this work explicitly forbids) or to add a second
`whenReady` concept for one caller to await. Awaiting the spawn fixes it at the
construction site rather than asking every reader to know about the window, which is
the preference `CONTRIBUTING.md` states. The host also **refuses** a spawn whose pid
never arrives rather than inventing one. Cost: ~40 test fakes gained `async` /
`Promise<PtyChild>` — mechanical, and `onData` → `onScreen` touched only the four
files that actually used it.

`onData` became `onScreen(screen: string)` for the same reason in the other
direction: a callback named for a byte chunk that delivers a whole rendered screen
would be false at every call site, and the ring beneath it would have gone on
appending screens to itself. The test fakes that drive it now keep an accumulating
`screen` and emit all of it, which is what a real scrolling pane looks like — and it
is what makes the existing auth-failure cases keep meaning what they meant: case 5
*requires* turn 1's banner to still be on screen during turn 2, which is exactly how
it proves the baseline diff excludes it.

### Protocol version

The socket server does **no** version check (only herdr's CLI guards) and the
protocol went 20 → 22 in 19 days. `connectHerdr` pings first, compares against
`HERDR_PROTOCOL_VERSION = 20`, and **throws**, naming both numbers — no warning, no
degraded mode. The gate is **equality, not a floor**: an older server is as
unverified as a newer one, and a `>=` check is a specific wrong implementation the
tests rule out in both directions.

### A green check count on a stacked PR is not a green PR

Recording this because the number looks complete on its own, and because the same
tell caught another lane the same day.

**A PR stacked on a non-`main` base gets 13 checks. A PR based on `main` gets 17.**
Measured: `gh pr view 641 --json statusCheckRollup` returned 13 entries, while
#636, #638 and #642 — all based on `main` — each returned 17. The four absent from
the stacked PR are exactly `CodeQL`, `Analyze (actions)`,
`Analyze (javascript-typescript)` and `Analyze (python)`.

**The reason is invisible from inside the tree.** `.github/workflows/` contains
only `ci.yml` and `leak-gate-nightly.yml` — there is no CodeQL workflow to read, so
grepping the repo for one finds nothing and proves nothing. CodeQL here is GitHub's
**default setup** (`GET /repos/:owner/:repo/code-scanning/default-setup` →
`state: configured`, languages `actions`, `javascript`, `javascript-typescript`,
`python`, `typescript`), and default setup scans pull requests against the DEFAULT
BRANCH only. `main` is the default branch, so a PR based on `feat/537-stable-reply-sink`
is never security-scanned at all.

So **13/13 on a stacked base is provisional, not green**, and this change — a new
socket client, a new ring implementation and a new key encoder — is exactly the
surface CodeQL exists to read. The same day, CodeQL failed #638 with two
high-severity alerts, one of which led to a guard blind to any `$`-prefixed
identifier that its author had shipped believing the file was covered.

**`gh pr checks` dedupes to the latest run; `statusCheckRollup` does not.**
Retargeting a PR's base cancels the in-flight run (ci.yml's concurrency group) and
starts a fresh one, and for several minutes `statusCheckRollup` returns BOTH — 28
entries here, the cancelled run's 13 plus the new run's 17, carrying a
`test: FAILURE` that belongs to the cancelled side. A count read in that window is
meaningless in both directions: inflated, and carrying a failure that describes
nothing. Read `gh pr checks` for a verdict, and treat a rollup count taken during a
re-run as no reading at all.

**A review can also be partial without saying so in its verdict.** One pass over
this branch read the first 6,000 of 6,269 diff lines; its conclusions simply did not
cover the remainder, and nothing in the verdict line said which part it had seen.
Same family as the check count: an output that looks complete because it is
well-formed. The tail here was re-read by hand — `repl-session.ts` (the `RingMark`
type change), `spawn.ts` (the host swap, the `await`, `onScreen` → `ring.replace`),
`supervision.ts` (a comment), `signatures.ts` (`submitCommand`),
`session-size-watchdog.ts` (`COMPACT_COMMAND` + the enter submit) and two mechanical
`async spawn` test edits — and every change in it is one already covered by a
mutation above (M7/M9, M23, M26, M22, M24). Nothing new was found, which is the
result, not the reason to skip the pass.

**The tell is a check count BELOW the rollup's**, and it is worth naming because
every individual check says `pass` and the summary line reads complete. Compare the
count against a `main`-based PR before calling a stacked one green, and gate the
REBASED head — the full 17, CodeQL included — not the stacked one.

**Rebasing onto `main` is therefore not tidiness; it is the only path to being
scanned at all.** That distinction is the whole point, and getting it wrong is what
keeps a stacked PR unscanned indefinitely: "rebase when the base lands" sounds like
housekeeping that can wait, and it is in fact the difference between scanned and
unscanned. This branch was rebased onto `main` BEFORE #537 merged, once a pre-flight
showed the change was independent of it — `git rebase --onto origin/main HEAD~1`
applied cleanly and the suite came up 879 pass / 0 fail against plain `main`. #537
was a BASE, never a dependency, and treating it as one had turned two independent
merges into a serial chain behind someone else's open gate.

**And this is a third authority for an absence claim.** The repository's own rule is
that an absence needs a grep with a positive control. That is necessary and here it
is not sufficient: a working grep over a correct checkout still reports nothing,
because the fact does not live in the repository. Three places an absence can hide:
the FILESYSTEM (a stale checkout), the REF (the wrong commit), and — this one — the
API, where the configuration lives outside version control entirely. The last is the
least obvious, because the repo looks like the complete source of truth and the grep
looks like it worked.

### An obligation starts when the resource exists, not when the function succeeds

Review r3 found three more, and they are one defect in three costumes. Each is a
resource or state obligation that begins at an EARLIER moment than the code
acknowledged, and each was invisible for the same reason: **the happy path
established the obligation and the error path was written as though it had not.**

- **A failed spawn leaked the pane.** After `layout.apply` returns, the pane and the
  `claude` process inside it EXIST. Both initialization failures after that point —
  the pid never arriving, the exit subscription refusing — closed only the
  CONNECTION. The caller got a rejected spawn while the process kept running
  unmanaged, and nothing held a record of it, because the pool never learns about a
  spawn that failed. **That is an orphan manufactured in the constructor, on an error
  path, where nobody will ever look for it** — the same class two other lanes spent
  the day on (#642, a death nobody can attribute; #577's P0, an orphan holding a
  credential nobody revokes), except created at birth. `abandonPane` now sends a
  best-effort `pane.close` on every post-creation failure, and does NOT fire when
  `layout.apply` itself failed, because then there is no pane and no obligation.
- **The viewport was cached forever.** `viewport_rows` was read once, while
  undefined. A pane resized from 62 to 300 rows went on requesting 262 — and under
  this backend's own blank-row semantics, where blank rows count before trimming,
  that request can return NO CONTENT AT ALL. Every positional detector blind, nothing
  failing. Re-read every `HERDR_VIEWPORT_REFRESH_MS` (5 s ≈ 20 polls), keeping the
  last MEASURED height when a read cannot conclude rather than falling back to the
  constant.
- **The client ignored short writes.** `SocketLike.write` returns the bytes
  ACCEPTED, and `call()` discarded it. A socket that took zero bytes, or half a
  frame, left a pending promise whose request never reached the server: a HANG, not
  an error — and the one "the channel is not working" shape `'transport-lost'` did
  NOT cover, because the socket is open, nothing threw and nothing closed; the bytes
  simply did not all go. A short write is now terminal: it fails the call and kills
  the connection, which surfaces through the `'transport-lost'` route built one round
  earlier. Retrying partial frames was the alternative and was declined — correct
  resumption is real work, and a transport that cannot accept a frame is not one this
  host should keep driving a REPL over.

**The test fake could not see this class by construction.** Every framing test used a
transport returning `d.length` unconditionally, so no short write was expressible.
The fake now takes an `accepts(frame) => number` function, and two of the pre-existing
framing tests — which stubbed `write: () => 0` — went red the moment the guard
landed, which is the guard working rather than a harness detail.

**One thing my own mutation run corrected, and it is the useful part.** I wrote the
byte-vs-string-length comparison with the failure direction BACKWARDS, claiming that
comparing `String.length` would make a good write read as short. M34 survived, which
said otherwise: `String.length` counts UTF-16 units, which is SMALLER than the byte
count for any non-ASCII frame, so comparing against it makes the check too **lax**,
not too strict — a socket accepting 42 of 45 bytes on a 40-unit frame is genuinely
short, `42 < 40` is false, and it hangs exactly as before. One accented character in
an argv, cwd or env value opens that gap. The test now lands inside it (accepted >
units, accepted < bytes) and asserts the gap is real before asserting the refusal.

### A measurement is only about what it measured

Review r4, and the sibling to r3's lesson. Every one of these is a **false claim of
knowledge**: "the pane is gone" from a failed question, "the stream is fine" from a
stream the code had just declared bad, "this is 400,000 bytes" from a count of
something else. A rejection measures the CALL, not the pane. `.length` measures
UNITS, not bytes.

- **`PtyRing`'s byte bound was a UTF-16 code-unit bound.** `replace` and
  `clampLeadingLines` compared `String.length` against `maxBytes`, so
  `'é'.repeat(400_000)` — 400,000 units, **800,000 bytes** — was retained untrimmed
  against a documented 512 KiB limit. Every bound in that file is now measured with
  `utf8Bytes`, the tail cut walks off UTF-8 continuation bytes so it can never split
  a character (an astral char is 2 units and 4 bytes, and breaks both a code-unit
  slice and a naive byte slice), and a note at the constant says the unit out loud.
  **This is M34 a second time, in a file I wrote in the same PR.** I had already
  found the units confusion in the write path, documented that code units are FEWER
  than bytes so the check goes LAX, fixed it — and left the identical error, failing
  in the identical direction, three functions away. A units confusion is never one
  site: whoever wrote one wrote the others with the same mental model. The whole
  diff was grepped for `.length` against a byte budget (with a positive control that
  found the already-fixed client site); `pty-ring.ts` was the only other production
  file, and every one of its sites now tells the same story.
- **A transient RPC failure was read as a vanished pane.** `paneIsGone` returned
  true for EVERY `pane.get` rejection — timeouts, temporary server errors, transport
  hiccups — so a live REPL was recycled and stamped `'pane-vanished'`, a claim
  nothing had observed, contradicting the method's own "definite exit" docstring.
  Measured on the live server: a genuinely absent pane answers with a TYPED
  `{"code":"pane_not_found"}` (for `pane.get` and `pane.read`, and for a malformed
  id too), so absence IS discriminable from failure. Only that code now proves it.
  The cost of the strict reading — a pane we cannot ask about keeps being polled
  instead of being declared dead — is the correct side to err on: a dead connection
  is already terminal via `'transport-lost'`, and a turn against an unresponsive
  REPL is ended by the inactivity watchdog. A confident wrong answer is the thing
  that must not happen.
- **A malformed frame left the connection usable.** The parse-failure branch said
  the stream position was untrustworthy, failed the pending calls, and left
  `closed === false` — so the next RPC went out over the very stream it had just
  declared unusable. Exactly the short-write shape from r3: the code knows the
  channel is broken and keeps using it. It now routes to `onClose`, i.e. to
  `'transport-lost'`, and the test asserts BOTH halves — pending calls reject AND
  later calls are refused — because the first half was already true before the fix.

### "Terminal" was a flag, not an action — and the units confusion, a third time

Review r5. Three blockers, all in the client transport, and the first two share one
root worth naming as one thing.

**`onClose` marked; only `close` tore down.** `onClose` set `closed = true` and
rejected the pending calls; `socket.end()` lived in `close()`, which returns early
when `closed` is already true. So both terminal routes built in r3 and r4 — a
malformed frame and a short write — went through `onClose` and **left the socket open
until the peer happened to close it**, while this record claimed they killed the
connection. There is now ONE `teardown(err)`: idempotent, ends the socket exactly
once, rejects EVERY pending request, and is the only thing `onClose`, `close`, and
all three failure routes call.

**Why it was invisible, which is the part worth keeping.** `isClosed()` returning
true is the SYMPTOM of teardown, and that is what the tests asserted — against a
fake whose `end` was a no-op nobody observed. **Asserting the flag cannot distinguish
a teardown from a relabelling.** It is the same mistake as asserting a byte bound
instead of retention (M36, found the same way), and the fix is the same: observe the
ACTION. The fake's `end` is now counted, and every route asserts "ended exactly
once", with a control that a healthy exchange ends it zero times.

**A thrown `sock.write` was the third route, and was unhandled.** It rejected only the
new request, left `closed === false`, and left other in-flight requests untouched —
so an earlier unanswered request never settled and later calls went out over a socket
that had just refused one. It now takes the same teardown.

**Inbound UTF-8 was decoded per socket chunk.** The transport called `d.toString()` on
every arbitrary chunk and `onBytes` buffered decoded STRINGS, so a multi-byte
character split across two chunks became two U+FFFD — one per half — and **the JSON
still parsed**, so nothing failed: pane text and server error messages corrupted
silently. `onBytes` now takes `Uint8Array`, buffers BYTES, and decodes one complete
line at a time. That is safe precisely because the delimiter is the byte `0x0A` and a
UTF-8 continuation byte is always ≥ 0x80, so a newline can never fall inside a
multi-byte sequence: **a line boundary is always a character boundary.** Changing the
parameter type turned every string-feeding test into a compile error, which is the
boundary becoming explicit rather than a comment asking for care.

**This was the same mental model three times in one PR** — M34 in the write path,
`PtyRing`'s byte bound, and now inbound decoding — and each time the test that missed
it was ASCII-only. So the sweep this round was not for `.length`: it was for **every
place a byte sequence becomes a string or vice versa**, across every production file
the diff touches. Eight boundaries; seven correct (`herdr-client`'s `byteLength`,
`herdr-host`'s `write` — a complete caller payload, not a stream chunk — `pty-ring`'s
`utf8Bytes`/`tailBytes`, and three `randomBytes().toString('hex')` which involve no
UTF-8 at all); one wrong, the per-chunk decode. Worth noting that
`session-size-watchdog.ts:120-131` already had the right discipline and said why —
"a `string.length` would over/under-count" — so the correct pattern was in a
neighbouring file the whole time.

**The invariant now written at the boundary: bytes are decoded exactly once, at a
point where the byte stream is known to be complete.** The multibyte test splits a
frame at EVERY interior byte boundary, and again one byte per delivery, asserting the
exact decoded content rather than a successful parse — because a successful parse is
what made this silent.

### A channel can be unusable without anything about it being false

Review r6. Two blockers, and the first is the fourth route to a dead channel.

**An answered-nothing RPC hung forever.** `call()` installed a pending promise with
no clock after a SUCCESSFUL full write. Zero writes, partial writes, thrown writes,
malformed replies and closed sockets are all routes where SOMETHING GOES WRONG, and
each hands you something to react to. A socket that accepts the entire frame and then
never calls `onBytes` or `onClose` hands you nothing — no error, no close, no event —
with `isClosed()` cheerfully false. That is the step past r5's lesson: **asserting the
flag cannot distinguish a teardown from a relabelling, and here there is no flag to
assert at all. Liveness needs a clock, not a predicate.**

It hung the two worst places. `connectHerdr`'s `ping` is mandatory, so an unbounded
wait there means the gateway never finishes starting and there is nothing to read;
and any `pane.read` stalls the poll loop. `HERDR_RPC_TIMEOUT_MS` (10 s — far above
`layout.apply`, the slowest call this client makes, and 40× the poll cadence) now
bounds every request, and it fires through the SAME `teardown()` the other five routes
reach. The clock is cleared the moment a reply lands, so a healthy connection is never
torn down — mutated in both directions (M48 no clock, M49 clock never cancelled).

**`kill('SIGINT')` latched `wasKilledByUs` and blinded every later crash.** The host
set the flag BEFORE distinguishing the signal, then sent `ctrl+c` and returned without
terminating anything — leaving the child ALIVE and marked intentionally-terminated.
`spawn.ts` treats any `wasKilledByUs()` child as a clean recycle, so a genuine crash
after an interrupt was silently unregistered.

This matters more here than it would anywhere else, and this document's own brief says
why: **herdr has no exit codes, so crash-vs-recycle collapses entirely onto
`wasKilledByUs`.** Latching the only discriminator you have, on a NON-TERMINAL
operation, destroys it for the rest of the child's life. Only terminal operations latch
it now; SIGINT is a transient intent and has its own `wasInterruptedByUs`, documented
as never licensing an exit verdict.

**And my own test asserted the contradiction as intended behaviour** — `hasExited()`
false AND `wasKilledByUs()` true, with a comment explaining the second as correct.
That is the same failure as a "KNOWN GAP" arm: **a test that documents a contradiction
instead of refusing it.** When a test's own assertions describe a state that cannot be
coherent — alive *and* killed-by-us — the test is the signal, not the fixture. It now
refuses it, and the regression the gate named is pinned: SIGINT, then an unexpected
exit, classified as a crash through the exact expression `spawn.ts` evaluates.

### A category defined by how it fails, rather than by what it must be

Review r7. Two blockers, and neither is a mistake inside a category this build had
modelled — they are two categories that were never on the list. Six rounds hardened
the transitions between enumerated states; these are states nobody enumerated.

**Valid JSON of the wrong shape escaped the malformed-frame teardown.** The category
built for was **"the parser throws"**, so everything `JSON.parse` ACCEPTS and the
protocol forbids fell outside it. `JSON.parse('null')` returns `null`, and the first
property read (`null['event']`) throws a `TypeError` out of `onBytes` — past the
teardown entirely, leaving pending requests and socket cleanup to whatever happened
next. Worse, `[]\n` and `{}\n` did not even throw: they parsed, matched nothing,
and were **silently ignored**, which is the failure mode with no signal at all. `{}` is
the instructive one — it parses, it IS an object, and it answers nothing.

`classifyEnvelope` now requires a non-null non-array object carrying one of herdr's two
actual shapes (`{event, data}` or `{id, result|error}`, the latter including the
measured `id: ""`), and anything else reaches the same teardown as a parse failure.
Nine boundary shapes are pinned — `null`, `[]`, `{}`, a bare number, string and
boolean, an id with no outcome, an outcome with no id, a non-string `event` — with a
control that both legitimate envelopes still work.

**Inbound framing had no size bound.** Every chunk was concatenated with no maximum
before a newline arrived, so a peer that never sends `0x0A` grows the buffer until
exhaustion, copying quadratically on the way. The RPC clock cannot help: bytes keep
arriving whether or not a request is waiting.

**And this is the undeclared half of the risk this record already names.** The protocol
went 20 → 22 in nineteen days with no server-side version check, which is exactly why
the `ping` comparison exists — but that catches a change the server DECLARES. A framing
change it does not declare (a different delimiter, a length prefix, a binary envelope)
presents as precisely this: bytes that are well-formed so far and never terminate.
`HERDR_MAX_FRAME_BYTES` is 8 MiB, derived rather than picked (a 999-line screen bounded
at 512 KiB, times several-fold JSON escaping, is low single-digit megabytes), and
exceeding it tears down. Tested EXACTLY at the limit — where a legitimate maximal frame
must still complete, because a bound that rejects one is a new failure mode — one byte
over, and accumulating one byte at a time so the limit is on what has gathered rather
than on any single delivery.

**The shape worth keeping, and it extends r6 cleanly.** A channel can be unusable
without anything about it being false; and **a payload can be well-formed without being
valid, and well-formed-so-far without ever being complete.** "Malformed" was defined by
the parser's behaviour instead of by the protocol's requirement, and "a frame" was
assumed bounded because frames are normally small — an expectation, not a limit.

**M53 survived first, and the reason is this session's dominant defect again.** My
boundary tests used a 5 s RPC clock, so a client that simply IGNORED a bad frame was
still torn down — by the timeout, seconds later — and the tests passed without the
validation existing. They were asserting the observable (`isClosed()` eventually true)
rather than the requirement (torn down BECAUSE the frame was invalid). Fixed by pushing
the clock out to 60 s and asserting `isClosed()` SYNCHRONOUSLY on the same tick as the
frame, where no timer can have run. That is the fourth time this build a test of mine
asserted what the code does instead of what must be true.

### A guard must run before the thing it guards, and a producer must not start before its consumer can exist

Review r8, and this is the ordering twin of r3's lesson. Both failures are CORRECT CODE
IN THE WRONG POSITION, which is why every unit of it reads fine in isolation.

**The first screen could be delivered before anything could scan it.** `spawn()` started
the poll loop before constructing and returning the child. The caller cannot assign
`scanChild` until `await ptyHost.spawn(...)` resolves, and `onScreen` returns without
scanning when it is undefined — so with an immediately-resolving RPC (which the fake
server demonstrates) the poll continuation delivers the initial screen before the caller
resumes.

**And because snapshot-replace deliberately suppresses an unchanged screen, that screen
is never delivered again.** A startup trust prompt or approval dialog therefore goes
unscanned and undismissed for the life of the child — a REPL alive, polling, and
permanently waiting on a prompt nobody saw. That is the worst outcome available to the
detector path, and the first screen is exactly where trust prompts live.

**Provenance, worth recording because the earlier decision was right.** Making `spawn`
async was correct: a synchronous one handed back a child whose `pid` read 0 while
`supervision.ts` probed it, and fixing it at the construction site beat patching the
reader. It also created this window, which did not exist when the caller received the
child synchronously. The general form: **an `await` inserted between a producer and its
consumer creates a window for everything the producer already started.**

Fixed by ordering, not retry: `PtyChild.beginOutput()` is an explicit readiness boundary
the poll loop awaits BEFORE its first read — before it can mutate the ring or stamp
`lastDataAt`, not merely before it delivers. `spawn.ts` calls it as the last step of
wiring, after `scanChild` and `liveHandle`. The gate FAILS OPEN after
`HERDR_OUTPUT_GATE_MAX_MS` with a loud warning, because withholding output forever is
worse than delivering it late: a REPL whose screens never reach the detectors is wedged
silently and looks idle. The gate orders delivery; it does not authorise it.

**The frame bound was checked after the dispatch it should prevent.** `onBytes` located
and decoded each complete line, dispatched it, and only THEN checked `maxFrameBytes`
against what remained UNTERMINATED. So a valid 1 MiB reply followed by `\n` parsed
normally — by the time the check ran the buffer was empty. The bound guarded
ACCUMULATION, not A FRAME, and the exposure it was added to close stayed open for every
oversized frame that arrived terminated. Every earlier test fed bytes WITHOUT a newline,
exercising only the half that already worked.

The size check now runs on `nl` — the frame's byte length — before anything reads its
content. And per the review's prompt to check the rest of the ordering: the deliberate
order in `onBytes` is now (1) size on bytes, (2) one decode of a complete line, (3)
parse, (4) envelope validation. Steps 3 and 4 are necessarily after the decode — you
cannot parse bytes you have not decoded — so that ordering is inherited AND correct; the
size check's was inherited and wrong.

**One test of mine passed for the wrong reason again, and M58 found it.** The
first-screen-signature test registered its scanner synchronously after the await, which
with an immediately-resolving fake left the race tight enough that removing the gate
entirely still passed it. Widening the window with a deliberate `await` before wiring
made it real: the requirement is what must be pinned, not the narrowness of one caller's
window. Fifth instance this build of the same shape.

### Settlement is not confirmation, and a detached write cannot support any claim about its effect

Review r9, and the deepest of the seven, because the code was not wrong about anything
it *did* — it was wrong about what it was entitled to *say*.

**A failed `pane.close` reported a clean termination.** `kill()` settled from
`.finally()`:

```ts
client.call('pane.close', { pane_id: paneId }).finally(() => settleExit('closed-by-us'))
```

`.finally()` runs on rejection too. So a `pane.close` the server REFUSED still resolved
`exited`, flipped `hasExited()` to true and reported `exitCause()` as `'closed-by-us'` —
a live REPL recorded as cleanly ended, with the pane still sitting there. Two separate
things broke on that one word. `terminateChild` (`repl-session.ts:357-377`) returns early
at **both** of its `child.hasExited()` guards — 361 and 370 — so the SIGKILL rung of the
escalation ladder never ran and the process leaked; and `killedByUs` latched on an
attempt that closed nothing, which, with no exit codes anywhere in herdr, is the
*entire* crash-vs-recycle discriminator, so every later real crash on that still-living
child read as an intentional recycle for the rest of its life. Exactly the failure mode
r6 wrote up for SIGINT, reached by a different road: **only a CONFIRMED terminal
operation may latch it.**

The fix is not to settle later, it is to settle on a fact: `.then(onOk, onFail)`, with
`settleExit` only on the success arm, and the kill flag CLEARED on the failure arm. Not
settling is also what re-arms the ladder — `hasExited()` stays false, the grace race
times out, and `kill('SIGKILL')` makes a second bounded attempt. **Escalation is the
retry**; nothing else had to be built for it.

One simplification fell out of trying to mutate it. I first kept two flags — an
`attempting` and a confirmed `killedByUs` — and could not construct a mutation that
reddened for dropping the second, because after a confirmed close the two are true in
exactly the same states. **Unobservable state cannot be tested, only believed**, so it
collapsed to one flag: set when a terminal kill is REQUESTED (which is what makes a
`pane_exited` racing our own close read as intentional), cleared if that request fails.

**And `write`/`writeKey` could not support what their callers claimed.** The same defect
one layer up, and a repeat offender: r4 fixed `writeKey?.('enter')` silently skipping the
submit, and `context-reset.ts` still returned `{status:'reset'}` for a reset that never
happened — now because `write` and `writeKey` are `void`. Over a socket they hand a frame
to the transport and return; a REFUSED frame and a delivered one are the same observable
event. The worst case is the partial one: text accepted, Enter refused, so `/clear` sits
typed at the prompt with the full context intact, and the pool records an empty one.

So `PtyChild` grew `submitLine(command): Promise<void>` — the acknowledged operation —
and `submitCommand` uses only that, refusing a child that lacks it **even when that child
has both `write` and `writeKey`**. What is refused is the unacknowledged seam, not the
keyless one. Both callers now `await`: `context-reset.ts` turns a rejection into
`{status:'failed'}` with the backend's reason, and `pool.ts`, whose policy is
log-and-proceed, emits its `context-reset /clear failed` line — which, on that path, is
the only thing in the world that distinguishes a reset from a non-reset.

That last point is worth its own note, because I nearly recorded it as untestable.
M26b (r6) survived against the `pool.ts` path and I reported it inapplicable, reasoning
that a path which logs and proceeds has no discriminating outcome. That was wrong, and
M70 was the same mutation arriving again: the log **is** the outcome. The requirement is
not "the import fails" (it must not — a stranded import is worse than a stale context);
it is "the operator can tell". A test capturing stderr, plus the control that an accepted
submit reports nothing, kills it. *Inapplicable* was a conclusion about my test harness
that I had dressed up as a conclusion about the requirement.

**And one thing the tree caught that I did not.** My first fix was
`.then(onOk, onRej)`, which is correct JavaScript and wrong here: a two-arg `.then`
handles the rejection BEFORE `fireAndForget`'s own `.catch`, so the failed close would
never have been counted or logged as a background rejection — a second, quieter version of
the same mistake, losing the evidence instead of the escalation. `scripts/ci/lint.sh`'s
PRE-SWALLOW GATE named it with the file and line and told me the shape to use
(`logger/fire-and-forget.ts:119-137` takes an `onError` third argument). It is now a
one-arg `.then` with the failure handling in `onError`, so the rejection is counted, logged
and *then* acted on. Worth recording because the gate found a defect class I had just
written two thousand words about.

**The third submit site is left alone, deliberately.** `session-size-watchdog.ts:326-345`
also does escape + text + `enter`, still fire-and-forget. I checked whether it belongs in
this fix and it does not: it never claims the compaction HAPPENED. It returns "we pressed
it", and it stamps the mid-compact lock BEFORE the writes precisely so a transport failure
cannot double-send `/compact` — with `compactLockMaxMs` releasing the lock so a failed
compaction is retried (`:326-328`). That is already the shape the P0 asked for on the
other path: retain state that permits bounded retry rather than assert an outcome.
Converting it would mean making a synchronous policy function async for no change in what
anyone is entitled to believe. Scoped and named, not silently narrowed.

**And the fake had to stop being agreeable — for the third time.** `pane.close` returned
`{type:'ok'}` unconditionally, so no test could have caught any of this. That is the
third requirement class this one fake has hidden: a no-op `end` hid a teardown that never
closed the socket (r5), a `write` that always returned `d.length` hid the short-write
class (r6), and now an unfailable `pane.close`. Each was fixed one method at a time,
which is precisely why there was a third. Failure is now injectable for **any** method
(`failMethod`/`clearFailure`), and so is latency (`holdMethod`) — the in-flight window is
where the `pane_exited` race lives, and a fake that answers instantly collapses that
window to nothing and makes every in-flight property vacuously true.

### The same defect a third time, in the validator — and the document sweep

Review r10, and the shape is now unmistakable, because it arrived through a third
completely different door.

**An exit event was silently dropped.** `classifyEnvelope` built the event envelope as
`data: asObject(o['data']) ?? {}`. The `?? {}` turns an ABSENT, `null`, array or
primitive `data` into a well-formed empty object: the frame validates, the handler is
called with `{}`, the `pane_id` comparison in `herdr-host.ts` fails, and the exit is
**ignored without a word** — the child keeps polling a pane that no longer exists.
`{"event":"pane_exited","data":null}` was accepted as valid and did nothing.

That is the r9 lesson with the actors swapped: **a missing fact coerced into a
well-formed empty one, so `unknown` rides the branch reserved for `known-and-empty`.**
In r9 a failed close became a clean exit; here a malformed frame becomes an empty
event. The remedy is the same in both — keep the two states apart and let the unknown
one reach the path built for it, which in the client's case is the malformed-frame
teardown I had already built and then routed around. It is also the defect the repo's
own memory names (*false and unknown must not share a branch*), which I had written
about in this very file before writing it into the code.

Five cases, mutated **individually**, because they are not one case: `in`/`undefined`,
`typeof null === 'object'`, `Array.isArray`, and primitive `typeof` are four different
branches, so a partial check passes some and fails others. Each single-shape leak
(M75a–M75e) reddens exactly its own case and nothing else, which is the proof that no
case in the table is redundant. And the pair matters as much: `data:{}` is genuinely
empty and must stay VALID (M74b), or "require `data`" degenerates into "reject anything
falsy" and breaks a legitimate fieldless event.

And the typechecker caught a weak assertion the runtime could not. My first control
reused one `seen` variable, resetting it to `undefined` before the second event —
which `bun test` accepted and `tsc` rejected, because the reset narrows the type. The
narrowing was pointing at a real gap: with a single overwritten variable, "the second
event arrived carrying `{}`" and "the second event never arrived, and this is still the
first one" are the same observation when the payloads happen to match. Collecting the
deliveries into an array fixes both the type and the assertion. Fifth time on this
branch that a gate found something I had reasoned past — and a reminder that
`typecheck-all.sh` is the gate, since `bun test` alone was green.

**The document sweep, decided per file.** Deleting a backend narrows a guard, and this
tree's rule is that every document asserting the old rule is fixed in the same change.
I had missed the worst one: `runtime/adapters/claude-code/AGENTS.md:5` still said the
REPL is hosted "(Bun-native PTY + dev-channel)" inside a sentence beginning "**It MUST
spawn…**". A per-directory `AGENTS.md` is the worst possible place to leave a stale
mandate, because it is injected into the context of the next agent working in that
directory — it would have built against a backend that no longer exists.

The sweep also taught me something about my own grep. My first pattern
(`Bun\.Terminal|bun-terminal`) found five files; the tree spells it
`Bun.spawn({ terminal })`, `Bun PTY` and `Bun-native`, and the real pattern finds
seventeen. **A grep is only as good as its guess at the vocabulary** — the absence-claim
discipline says a grep finding nothing proves nothing without a positive control, and
this is its sibling: a grep finding *something* does not prove it found *everything*.
**A completeness claim is only as wide as the instrument that checks it** — the same
defect as #638's coverage test keyed to a single spelling of an identifier, which is
why the surviving-hits check is now written as a criterion the reader can re-run rather
than a count I once got right.

Three outcomes, all legitimate, and the reason not to blanket-edit:

- **Defect — a live claim about current behaviour that is now false (7 fixed).**
  `AGENTS.md:5` (the mandate) and `:15` (the sprint log, which gets the later fact
  APPENDED so S1's history survives); `types.ts:355`, which named "Bun-native terminal
  host" as the *default* when the default is `HerdrHost`; `pty-noise.ts:18`;
  `SYSTEM-OVERVIEW.md:7630`, a present-tense claim that the regression guard "spawns
  claude under a real `Bun.spawn({terminal})` PTY" when its body now uses `HerdrHost`;
  and the docstrings of `dev-channel-pty-bind.e2e.test.ts:4` and
  `reminders/bundled-rituals.e2e.test.ts:21`, both describing a mechanism their own
  converted bodies no longer use. Plus my own `herdr-host.ts:4`, which called the
  deleted thing `Bun.Terminal` — a symbol that never existed.
- **Correct AS HISTORY — kept deliberately (5).** `spawn.ts:260` is inside an
  explicit `HISTORICAL NOTE (P0, 2026-06-26)`; `post-spawn-assertion.ts:25` records
  where a still-live design decision was *verified*; `SYSTEM-OVERVIEW.md:7569` records
  where a bug was *reproduced*; and both `docs/research/AS-BUILT-*-archive-2026-07.md`
  are archives. Those sentences are true statements about the past, and the harness
  was the Bun PTY at the time. Rewriting them would forge the record — the same reason
  an immutable decision log is never edited to match today's architecture. A
  find-and-replace across the sweep would have destroyed all five.
- **Already correct (2).** `pty-host.ts:12` and `__tests__/pty-noise.test.ts:4` had
  already been updated to say the Bun backend is gone.

Filenames stay. `dev-channel-pty-bind` and `pty-noise` are still accurate: a herdr pane
IS a pty, and what changed is who allocates it, which is what the corrected docstrings
now say. Renaming would churn every citation to buy nothing.

### A missing CI run is not a passing CI run

Worth recording because the failure mode is silence, and the naive check is green.

After the r10 push, `gh pr checks` reported **4 checks, all pass**. The `ci` workflow —
typecheck, lint, layering, purity, the 8 test shards — **had not run at all**. Only
CodeQL's four jobs existed, and they passed, so any monitor asking "is everything
settled and non-failing?" would have answered yes on a PR whose entire test suite had
never executed.

The cause: `main` had moved (#636, #650) and the PR was `CONFLICTING`. `ci.yml` triggers
on `pull_request`, which runs against the *merge* ref — and GitHub cannot compute a merge
ref for a conflicting PR, so the workflow was never created. A conflict does not show up
as a failing check; it shows up as **checks that do not exist**.

This is the same tell as the stacked-PR check count earlier in this build (13 vs 17), and
it defeats the same instinct. So the count is now part of the condition: the watcher
requires **17 checks present AND all non-pending** before it will call CI green, rather
than "all present checks are non-pending". *All of the checks that exist have passed* is
not a claim about the checks that should exist.

And the conflict itself had a trap. `docs/spec-items/README.md` is a **generated** rollup:
`scripts/__tests__/spec-items-index.test.ts:32` asserts the committed file is byte-exact
with the renderer's output, so a hand-resolved index fails CI *even when it reads
correctly*. My hand resolution happened to be right — I checked the three counts against
the filesystem (24 items, 5 blocking, 1 needs-spec) rather than adding the two sides — and
regenerating produced a byte-identical file. That the diff was empty is the point worth
recording, not the reassurance: reading correctly and being the renderer's output are two
different properties, and only the second one is what the gate tests. Regenerate, then
assert drift is zero.

### `{}` was the representation of "nothing usable" — three doors, one defect

Review r11, and the third appearance closed the argument about what these three bugs
have in common.

**A refused RPC was reported as a successful one.** The reply envelope was validated as
`typeof o['id'] === 'string' && ('result' in o || 'error' in o)` — the PRESENCE of a key,
with no check on what it held and no objection to both. So
`{"id":"n1","error":"refused"}` passed: `error` is a string, which the protocol never
sends. The dispatcher then did `asObject(env.error)`, got `undefined` for a string,
SKIPPED the error branch, and fell through to `p.resolve(asObject(env.result) ?? {})` —
`result` was absent, so the call **resolved successfully with `{}`**. A `pane.close` or
`pane.send_keys` the server refused, handed to `kill()` as an acknowledgement.

Put the three side by side and the cause is one sentence:

| Door | The coercion | What it destroyed |
|---|---|---|
| `kill()` (r9) | `.finally()` settles either way | a failed close became a clean exit |
| event `data` (r10) | `asObject(o['data']) ?? {}` | a malformed frame became an empty event |
| reply outcome (r11) | `asObject(env.result) ?? {}` | a refused call became an empty success |

**`{}` was being used as the representation of "nothing usable", and `{}` is
indistinguishable from a legitimate empty success.** An unknown must never be spelled
the same way as a known — which is the repo's own *false and unknown must not share a
branch*, arriving a third time in a costume I did not recognise until it was pointed out.

The fix requires exactly one outcome and validates its shape, and then does something
the previous two rounds did not: it makes the invariant **the compiler's** rather than a
comment's. The reply envelope is now discriminated on `ok`, so the success path has no
default to write — with `result`/`error` both optional, TypeScript still demanded a
`?? {}` for a state the validator had already excluded, and that unreachable default is
precisely the shape being removed. A defence that relies on everyone remembering an
invariant is one refactor from being the bug again.

Eleven mutations. M76 restores the presence-only check (reddens nine cases at once);
M77 accepts both outcomes; M78 is the over-strict twin, rejecting a legitimately empty
`result:{}` — which must stay valid for exactly the reason the bug existed, since `{}`
is what the client used to invent. M79a–M79d and M80a–M80d leak one wrong-typed shape
each, and every one reddens only its own row.

### The sweep this earned, made general rather than a third instance-hunt

Having hunted this defect three times by instance, the fourth had to be found by
*class*: every place in the client, host, protocol, ring and signatures that turns an
absent or wrong-typed value into a default, asked one question — **is the default
distinguishable from a legitimate value of that type?**

**36 sites examined, 4 changed.**

Two changed by deletion (the reply path above: the validator and the dispatcher's
`?? {}`, which no longer exists). Two kept their default but stopped being silent,
because in both the fallback is genuinely needed and genuinely indistinguishable:

- **`viewportRows ?? HERDR_VIEWPORT_ROWS_FALLBACK`.** 120 assumed looks exactly like 120
  measured. A REPL whose geometry cannot be read must still poll, so the fallback stays
  — but on a 400-row pane it sizes every read for 120, each read comes back short, and
  positional detectors see less than the 200 lines they are written against with nothing
  anywhere saying why. It now says so once. The control measures a real **120**, the
  fallback's own value, so the pair cannot pass by warning unconditionally.
- **A `pane.read` that SUCCEEDS with an unusable payload.** Neither an error nor an
  answer, and the two-branch code put it in the wrong one by omission. Leaving the screen
  `undefined` was already right — the ring must not receive an empty screen, which would
  erase a dead REPL's last output — but doing it silently means a drifted reply shape is
  indistinguishable from a permanently idle REPL. The protocol-version gate catches a
  *declared* change; this catches a same-version one. Paired with a control proving the
  skip is not a latch: a client that gave up after one bad payload would pass the first
  case and never poll again.

The 32 left alone are configuration and dependency defaults (`opts.rpcTimeoutMs ??
HERDR_RPC_TIMEOUT_MS`, `options.cwd ?? process.cwd()`), casts already followed by a
`typeof` check on the field actually used, and boolean conditions that are not coercions
at all. In each the default IS the contractually correct meaning of "absent". One
deserves naming because I had to check rather than assume: `typeof err.code === 'string'
? err.code : 'unknown'` is a silent default by the letter of the test, but nothing in the
tree ever compares a code to `'unknown'` — the only code branched on is
`HERDR_PANE_NOT_FOUND` (`herdr-host.ts:605`, with the grep's positive control) — and the
message still carries `JSON.stringify(err)`, so no information is lost and the
reject-versus-resolve decision cannot flip. It is a diagnostic label, not a decision
input.

The fake gained the third lever to make any of this testable: `failMethod` (it errors),
`holdMethod` (it is slow), and now **`malformMethod` (it answers with something unusable)**.
That set is complete in the way the per-method fix was not — a successful call with an
unusable payload is its own class, and it is exactly how a same-version shape drift
arrives.

### The rule all three defects violate: once settled, a terminal state is immutable

Review r12, and it names the thing the other two were instances of.

**A cleanup path rewrote a correct answer after the fact.** `settleExit` closes the
client (`herdr-host.ts`), and closing the real client runs `failAll` — so every RPC
still in flight rejects, INCLUDING the `pane.close` we ourselves issued. The rejection
handler then reset `terminating` unconditionally. Sequence: `kill()` → `pane_exited`
arrives → the exit settles as ours → the client closes → our own close rejects as a
consequence → `wasKilledByUs()` flips from **true to false**, after the child had
already settled. With no exit codes anywhere in herdr that flag is the whole
crash-vs-recycle discriminator, so a deliberate recycle was rewritten into an apparent
crash — by a handler that never asked whether the question was still open.

The rejection is not even evidence. Once `exited` is true the pane IS gone, so the
handler's own message — "the pane was NOT closed" — would have been a false statement
about a dead pane. The handler is only meaningful while the child is still alive, which
is exactly the condition under which clearing the flag is the truth.

Put beside the other two, the three stop being three bugs:

| | What it did to the terminal state |
|---|---|
| r9 — `kill()` settling from `.finally()` | settled the WRONG outcome |
| r11 — `asObject(result) ?? {}` | settled an UNKNOWN as an empty success |
| r12 — the unconditional reset | UN-SETTLED a correct answer |

**Once a terminal state is settled, no later path may rewrite it.** Every one of the
three is that sentence violated from a different direction, and each cost a review round
because I fixed the instance rather than the sentence. The r10 sweep found the third by
class instead of by instance and was right to; this is the same move applied to
*ordering* rather than to *values*.

**The test was measuring an intermediate state.** It asserted at the point the close was
still held and never awaited the rejection handler — so the last writer to the value
under test ran after the last read of it. An assertion taken before the final handler
runs is not a measurement of the outcome; it is a measurement of a moment. It now
releases the held call, drains a macrotask turn, and asserts again.

**And the fake hid it — the fourth time.** Its `close()` only set a flag, so a held call
released after the connection closed quietly SUCCEEDED; the real client's `close()` runs
`failAll` and rejects it. The combined mutation is the proof and is worth recording
precisely: with the host defect restored AND the forgiving fake, **the test passes** —
zero failures, bug present. The fake is the enabling condition, not a convenience. So
`close()` now fails every in-flight call, because a connection closing does not leave
the requests on it in limbo; it ends them, and the code downstream has to cope with a
rejection arriving for a call it made before the close.

That is the general form of the hazard the #537 lane hit from the other side: **a fixture
that performs the step under test turns a missing implementation into a passing test**,
and a fixture that *refuses to perform a step reality performs* turns a real defect into
a passing test. Both are the fixture deciding the outcome. I checked this test's
arrangement against it: the fake only EMITS `pane_exited` — the host's own subscription
handler is what settles — and nothing in the arrangement writes the flag being asserted.

### The fourth row: the rule has to hold at the EDGE, not just in the bookkeeping

Review r13. The first three rounds were all the host's own bookkeeping; this one is the
transport, and it is the same sentence one layer down.

**`onBytes` accepted and dispatched after teardown.** It appended every chunk with no
`closed` check, so bytes arriving after `close()` still parsed into a valid frame and
still invoked subscription handlers. The event that matters is exactly `pane_exited` —
the host's handler calls `settleExit` — so a post-close frame could **re-open the
question the close had just settled**. `settleExit` closing the client is a meaningless
guarantee if the socket can still write into the host afterwards.

It also quietly undid teardown's other job. Teardown releases `this.bytes` because it may
hold up to `maxFrameBytes`; with no guard, chunks arriving afterwards started accumulating
again — the buffer teardown claims to have released grew back, bounded by nothing and
read by no one.

| | what it did to the terminal state |
|---|---|
| r9 — `.finally()` | settled the **wrong** outcome |
| r11 — `?? {}` | settled an **unknown** as an empty success |
| r12 — the close/exit race | **un-settled** a correct answer |
| r13 — `onBytes` after close | let the **transport** write after all of the above had settled |

### The sweep: `closed` existing is not the same as every path consulting it

**14 entry points examined, 2 changed.** The finding named one door; the rule names a
class, so the class was walked.

Changed:

- **`onBytes`** — the defect above.
- **`subscribe`** — it registers the handler BEFORE awaiting the acknowledgement, which
  is deliberate and must stay: an event can arrive between the request and its ack, and
  the host subscribes to `pane_exited` precisely so an exit *during startup* is still
  seen. But a REJECTED subscribe returned no unsubscribe function, so the caller could
  not remove the handler and believed it was never subscribed — a handler nobody can
  reach that the dispatcher still calls. It is now removed on failure. Registering early
  is a race win, not a licence to leave state behind.

Left, with reasons: `call` and `ping` already reject on a closed connection; `close` and
`onClose` both delegate to `teardown`, whose own `if (this.closed) return` makes it
idempotent; `dispatch` is private and reachable only from the now-guarded `onBytes`;
`failAll` is teardown-internal; `isClosed`, `bufferedBytes` and the constructor hold no
state to corrupt. The RPC timeout **timer callback** calls `teardown`, so a timer that
survives a close is a no-op — and `failAll` clears the timers as it drains. `attach` is
the one deliberate omission: it is called once by `connectHerdr` before any use, and a
silent no-op there would hide a wiring bug rather than prevent one.

### An ordering I was asked to check, which turned out not to be load-bearing — and the mutation is why I know

The question was whether `closed` is set before or after `failAll`, on the theory that
if `failAll`'s rejection handlers can re-enter the client, the ordering decides whether
the guard holds during teardown or only after it.

It is set **before**, and I initially wrote a test claiming to pin that. The test was
wrong, and the faithful mutation found it: **MOVING** the assignment below `failAll` —
rather than deleting it, which is what my first sloppy attempt did and which reddened 38
cases for the wrong reason — **SURVIVES the entire suite.**

The reason is structural. `failAll` only calls `p.reject()`, and a promise's rejection
handler runs as a **microtask**: it cannot execute inside `failAll`, so every caller
observes the flag after `teardown` has already returned, under either ordering. **The
ordering is unobservable through the promise API and therefore not a criterion** — an
assertion about it passes for both implementations, which is the exact defect I have
spent this branch removing from other people's reasoning and had now written myself.

So the line stays (it costs nothing and remains the correct ordering if `failAll` ever
gains a synchronous callback), the comment says plainly that it is not load-bearing
today, and the test was renamed to assert what it actually discriminates: a re-entrant
call from a rejection handler is refused rather than half-served.

Two smaller notes from the same run, both about my own mutations rather than the code:
M90 as first written was a copy of M89 and proved nothing, and M91 deleted the assignment
instead of moving it. **A mutation that changes more than the one thing it names cannot
tell you which thing the test caught** — M91's 38 failures looked like strong evidence
and were evidence of a different bug entirely. Rewritten, M90 now reddens exactly the
accumulation case and M89 exactly the dispatch case, which is what separates the two
requirements.

### A limit on how much you KEEP is not a limit on how much you DO

Review r14, and it is the resource version of the sentence this branch keeps rediscovering.

**Inbound buffering was quadratic.** Every chunk copied the whole accumulation through
`Buffer.concat`, so cost grew with the *number of deliveries* while the 8 MiB frame cap —
which bounds only *retention* — sat there looking like it covered the hostile case.
One-byte deliveries force on the order of **35 TB of cumulative copying** before the cap
ever trips. The guard bounded the wrong quantity: **CPU was the resource actually
exhausted, and nothing was watching it.**

There were two quadratic sources, not one. The append was the reported one; the frame
loop had the same defect a level in, rebuilding the buffer after every frame
(`Buffer.from(subarray(nl + 1))`), so a batch of N frames in a single delivery was
quadratic too. Fixed as a queue of chunks concatenated ONCE when a newline actually
arrives, plus a cursor instead of a re-slice.

**And the test load had to be chosen by measurement, not by guess.** My first attempt fed
200k one-byte chunks under a 4 s bound — and the quadratic mutant finished inside it, so
**M94 survived**. Measured on this host: the queue takes **44 ms**, the concat-per-chunk
version **21,433 ms** — a 487× separation at 200k × 8 bytes. The bound now sits ~113×
above the passing implementation and ~4× below the failing one. *The load, not just the
threshold, is what makes a performance test able to see the defect* — and a wall-clock
assertion whose margin you have not measured is a guess wearing a number.

**A third instance of the same shape fell out of the fix.** `subarray` returns a VIEW,
so a 1-byte remainder of a 2 MB delivery pins the whole 2 MB while `bufferedBytes()`
truthfully reports 1. Watching the logical length would say the buffer is empty while the
memory is still held — the identical error one layer down. The tail is copied, and
retention got its **own observable** (`retainedBytes`) rather than being taken on trust,
because the number that was already there could not see it.

### "Loudly" was half a criterion, and the half nobody asserted

The gate test named *"FAILS OPEN, loudly"* asserted only that the screen eventually
arrived. But **"the screen arrived" is IMPLIED BY failing open and says nothing about
loudly** — silence the warning and the test stayed green, against both its own name and
the spec. An assertion that is a *proxy* for the criterion is not the criterion, and
**half a compound criterion asserted is a criterion not asserted.**

It now captures stderr and requires exactly one warning that names the wiring bug and the
consequence, paired with a control that a timely `beginOutput()` warns not at all —
without which "warns once" is satisfied by warning on every spawn, making the diagnostic
worthless precisely when it is true.

The control needed a **combined** mutation to prove it discriminates, because two guards
protect it: `beginOutput` clears the timer AND the timer checks `released`. Disabling
either alone leaves the control green; disabling both reddens it (M97c).

### The evidence rule this branch converged on

Stated once, because it has now paid three times — M88b (the fake), M96c (the accessor),
M97c (the gate):

> **When a mutation survives, ask what is absorbing it; when it reddens loudly, ask
> whether it reddened for the reason you think.**

Both halves cost something real here. M88 surviving alone was what proved the fake was
the *enabling condition* rather than a convenience, and the same shape recurred exactly:
**M96b survives alone, and M96c — the view plus a logical-length accessor — is GREEN with
the bug present**, which is the proof that the accessor measuring ALLOCATION rather than
length is what makes the retention defect visible at all. And M91's 38 red cases looked
like strong evidence while being evidence of a different bug entirely, because I had
deleted the assignment instead of moving it. A mutation that changes more than the one
thing it names cannot tell you which thing the test caught.

### The fifth row, and the sign is flipped: settling on the ABSENCE of evidence

Review r15. The first four rows were a settled state being **rewritten**; this one
settles on nothing at all.

**Transport loss settled a child that might still be running.** `pollLoop` turned a
closed socket straight into `settleExit('transport-lost')` — and settlement runs the
ordinary death handling in `spawn.ts`: session marked dead, sink unregistered, pool
entry dropped, temp configs deleted. The next request then spawns another `claude`
against the same session id and the same transcript **while the original is still
alive**. That breaks one-process-per-transcript, the invariant this substrate is built
on and which is enforced ONLY by killing the old process, and it leaves a
credential-bearing process running with nothing managing it.

`pty-host.ts` says transport loss is not evidence the process exited — in the interface,
twenty lines from the code that conflated them. **"The socket closed" and "the process
exited" are different facts.** `transport-lost` is an *unknown* disposition being
consumed as a definite one, which is the `?? {}` row promoted from a field to a
lifecycle.

**Termination, not adoption — and the reason matters.** Re-attaching to a surviving pane
across a fresh socket is #539 (a gateway restart bringing REPLs back) and is not built.
Until it is, the only disposition that preserves the invariant is ending the process. So
the host now runs the SIGTERM → SIGKILL ladder against the pid it learned at spawn —
`process.kill` being exactly the right tool precisely *because* it does not need the
herdr transport that just died — and settles **only on confirmed death**, because this
branch already has a row for a kill reported as successful when it failed. What it does
not clean up is the herdr pane, which may survive empty; that is cosmetic, and the
credential-bearing process is what the invariant is about.

**And when death cannot be confirmed, it does not settle at all.** Settling would
authorise a replacement against a process we know nothing about. A stuck session is
recoverable by an operator; two live processes on one transcript are not. Loud,
deliberately not terminal.

Two survivors made this round better rather than just longer:

- **M101 (a missing pid read as confirmed death) survived because the branch is
  unreachable** — `spawn` refuses to return a child whose pane never reported a pid. An
  unreachable defensive branch is untestable by construction, so it was deleted and the
  parameter tightened to `number` rather than left as belief dressed as caution.
- **M102 (EPERM counted as dead) survived because my tests inject the probe**, so the
  real one was never exercised — and its most important case is exactly that EPERM means
  the process EXISTS and merely is not ours to signal. Reading that as "dead" is the same
  defect in its most classical form, and it would report a live child terminated
  precisely when we have least authority over it. The probe is now exported and tested
  directly against three real outcomes on this host: own pid (alive), pid 1 (EPERM →
  alive), a bogus pid (ESRCH → gone).

### The guard was well-tested and every real caller was on the wrong side of it

All three live E2E callers awaited `HerdrHost.spawn` and none called `beginOutput()`. So
each waited out the full 5 s gate, tripped the "WIRING BUG" warning, and only then began
polling — **the opt-in proofs were silently taking the fail-open path and normalising
it.** The sharpest part is the timing: I fixed the *unit* test this same round so the
warning is asserted, while the three tests that would actually trip the wiring bug in
production were the ones tripping it.

It matters most in `ritual-write-containment`, where the disclaimer and the tool-use
prompt are both answered from `onScreen` — five seconds of unwatched screens is exactly
where a prompt goes unanswered. All three now release the gate, and the flagship boundary
test captures stderr and asserts **no** fail-open warning across the whole run, so the
unit test proves the warning fires when the call is missing and the live test proves the
real caller is on the right side of it.

### A PID is an identifier, not a handle

Review r16, and it is the direct consequence of the previous round's fix — which is the
honest shape of that decision, not a reason to undo it. Deciding to *signal* a process
created an obligation the previous design never had: to be sure which process it is.

The host kept only the number, probed it with `signal 0`, and signalled it. Sequence:
the pane process exits without delivering `pane_exited`; the kernel reuses its PID for
another same-uid process; the transport closes; the probe reports the replacement alive;
`terminateLostChild` **kills a stranger**.

The EPERM reasoning was right and is exactly why this bites. "Exists and is not ours to
signal" was the correct reading of EPERM — and a reused PID is *also* a process that
exists and is not ours, in a sense no permission check can see. So the probe became an
**identity** question rather than a liveness one: `/proc/<pid>/stat` field 22, the
kernel-maintained start time, captured at spawn and compared before every signal. One
question replaces two, and a different start time at the same PID is *positive proof*
our child exited — confirmed death, with nothing signalled.

`defaultPidAlive` is gone rather than kept beside it. An unused function with a test that
documents superseded reasoning is decoration, and the EPERM insight survives where it
belongs: in the comment explaining why liveness was not enough.

Two survivors, both worth the detour:

- **M106** — parsing by absolute field index — survived because `comm` on this host is
  `bun`, with no space in it. `comm` is the executable NAME and the kernel does not
  escape it, so an absolute index reads a different field for any process whose name
  contains a space or a parenthesis. The parser is now extracted and tested against
  exactly those shapes. *The fixture's own tidiness was hiding the hazard.*
- **M107** — retaining the delivered chunk in an extra field — survived, and is invalid
  by construction: it adds state the class does not have. The guarantee is that no such
  state exists, and that is enforced by the shape rather than by a check, which is the
  entire point of the section below.

### Three rounds on one buffer, so the property was made structural

Copying, then retention, then allocation count. Each fix bounded the quantity the
previous one had missed — which is a pattern that ends only when the quantity cannot
exist. Asked directly whether there was a shape in which a fragment cannot be retained
individually at all, the answer was yes, and it was the right move:

| round | what was bounded | what was missed |
|---|---|---|
| copying | — | cost grew with the NUMBER of deliveries (~35 TB at the cap) |
| retention | copying | a `subarray` tail pinned its whole parent |
| allocation | retention | one `Buffer` object per fragment — ~8 million at the cap |

**One buffer.** Incoming bytes are copied into it and the delivered chunk is dropped
immediately, so there is no fragment to retain, nothing to count, and no per-fragment
overhead to bound. Growth is amortised doubling (so N fragments still cost O(bytes)), a
cursor replaces re-slicing, and consumed prefixes are reclaimed in place. **The guard is
the data structure, not a check** — which is why M107 could only survive by inventing a
field that does not exist.

Two things the rewrite then had to earn back, both caught by my own mutations rather than
by reasoning:

- **Bounded is not the same as small.** A high-water buffer kept 2 MB alive after one
  large frame. It now right-sizes when the remainder becomes a small fraction of
  capacity, and releases outright when fully drained — retention tracks *current need*.
- **Right-sizing is not truncation.** M108b (shrink always to the initial capacity)
  survived until a case existed with a LARGE outstanding partial frame; the earlier
  leftovers were one byte and fit in any capacity. A 300 KB remainder after a 2 MB frame
  is what separates right-sizing from silently dropping data.

And one ordering mistake of my own: I moved the unterminated bound ahead of the frame
loop, which made a complete oversized frame report "no newline" about bytes that contain
one. The per-frame check belongs inside the loop ahead of the decode; the leftover check
belongs after it. Five tests caught it immediately, which is the system working.

### One authoritative behaviour, not two reconciled ones

The transport-loss criteria had come to contradict each other — every socket close
settles, and settlement requires confirmed death. Both cannot hold. The obsolete
criterion and its two tests are **deleted rather than reworded**, because those tests
passed for a reason the second one had written down in its own comment: the fake's
default PID does not exist, so `signal 0` throws ESRCH and "already dead" was trivially
true. They observed settlement without ever exercising termination.

A test whose fixture decides the outcome is worse than no test — it certifies the
opposite of the requirement — and one whose comment *names* the false-positive mechanism
makes keeping it the more expensive choice.

### Mutation table

Every guard was mutated and every mutation reddened. Run against the named suites.

| # | Mutation | Result |
|---|---|---|
| M1 | protocol gate removed (`if (false)`) | RED 3 |
| M2 | gate becomes a floor (`<`) instead of equality | RED 2 |
| M3 | `exited` resolves `0` instead of `null` | RED 4 |
| M4 | deliver on every poll, not on change | RED 1 |
| M5b | `catch { text = '' }` with no pane probe | RED 3 |
| M6 | suppress an empty screen (breaks the falling edge) | RED 1 |
| M7 | `textSince` returns the whole current screen | RED 9 |
| M8 | set difference instead of multiset | RED 3 (incl. the live warm-latch-re-arm case) |
| M9 | `mark()` captures an empty baseline | RED 9 |
| M10 | `replace` appends (the diff-append shape) | RED 13 |
| M11 | byte-slice clamp instead of line-aligned | RED 1 |
| M12 | key map emits `ctrl-c` (the form the server rejects) | RED 5 |
| M13 | `write()` accepts `\r` (silent never-submits) | RED 2 |
| M14 | poll interval raised to the quiet window (250 → 900) | RED 2 |
| M15 | read window narrowed below the widest detector (200 → 40) | RED 1 |
| M16 | read drops the viewport allowance | RED 3 |
| M17 | viewport hardcoded instead of read | RED 2 |
| M18 | invent a pid instead of refusing the spawn | RED 1 |
| M19 | `pane_exited` not filtered by `pane_id` | RED 1 |
| M20 | `pool.ts` `/clear` with no submit | RED 1 |
| M21 | `context-reset.ts` `/clear` with no submit | RED 12 |
| M22 | `/compact` with no submit | RED 9 |
| M23 | `spawn.ts` appends screens into the ring | RED 1 (the stale-banner case) |
| M24 | the real child omits `writeKeys` (makes the byte fallback reachable) | RED 2 |
| M25 | transport loss does not settle the child | RED 2 |
| M26 | restore the silent skip (`?.` on `writeKey`) | RED 2 |
| M27 | drop the read-cap clamp | RED 4 |
| M28 | OVER-EAGER clamp — cap every request regardless of viewport | RED 5 |
| M29 | `exitCause` collapses to a constant | RED 2 |
| M26b | silent skip, run against the `pool.ts` reset path | SURVIVED — inapplicable, see below |
| M30 | an init failure leaks the pane (closes only the connection) | RED 2 |
| M31 | OVER-EAGER cleanup — close a pane `layout.apply` never created | RED 1 |
| M32 | viewport cached forever | RED 2 |
| M33 | short write ignored | RED 2 |
| M34 | compare `String.length` instead of byte length | RED 1 (after the gap test) |
| M35 | ring bound measured in code units | RED 1 |
| M36 | per-line drop accounting in code units | RED 1 (after the retention test) |
| M37 | tail cut by code units, splitting characters | RED 3 |
| M38 | any rejection means the pane is gone | RED 2 |
| M39 | OVER-STRICT — never conclude absence at all | RED 4 |
| M40 | malformed frame leaves the connection usable | RED 1 |
| M41 | OVER-EAGER — close on every inbound frame | RED 12 |
| M42 | teardown MARKS without closing the socket (the root) | RED 4 |
| M43 | malformed-frame route bypasses teardown | RED 2 |
| M44 | short-write route bypasses teardown | RED 4 |
| M45 | thrown-write route bypasses teardown | RED 1 |
| M46 | per-chunk decode restored | RED 2 |
| M47 | teardown not idempotent (closes more than once) | RED 1 |
| M48 | no RPC clock — a complete frame with no reply hangs | RED 2 |
| M49 | a reply does not cancel the clock (healthy conn torn down) | RED 1 |
| M50 | the timeout bypasses teardown | RED 1 |
| M51 | SIGINT latches `killedByUs` again | RED 3 |
| M52 | a TERMINAL kill stops latching `killedByUs` | RED 3 |
| M53 | no envelope validation (parsed treated as valid) | RED 9 (after the sync assertion) |
| M54 | OVER-STRICT envelope — reject everything | RED 18 |
| M55 | no inbound size bound | RED 2 |
| M56 | off-by-one — rejects a frame EXACTLY at the limit | RED 1 |
| M57 | frame size checked AFTER dispatch (the original defect) | RED 2 |
| M58 | poll loop ignores the output gate | RED 2 (after widening the window) |
| M59 | the gate never fails open | RED 1 |
| M60 | `beginOutput()` does not release | RED 17 |
| M61 | frame bound `>=` — rejects a maximal COMPLETE frame | RED 2 |
| M62 | settle from `.finally()` — settle whether or not the close succeeded | RED 2 |
| M62b | PAIR: settle ONLY on a failed close, never on a successful one | RED 3 |
| M63 | do not clear the kill flag when the close fails (latch on the attempt) | RED 1 |
| M63b | PAIR: clear the kill flag on a SUCCESSFUL close too | RED 2 |
| M64 | `wasKilledByUs` always false | RED 6 |
| M65 | `submitLine` sends the text fire-and-forget instead of awaiting it | RED 1 |
| M65b | PAIR: `submitLine` sends Enter BEFORE the text | RED 2 |
| M66 | `submitLine` swallows a refused Enter | RED 1 |
| M67 | `submitCommand` falls back to `write`+`writeKey` when `submitLine` is absent | RED 1 |
| M68 | `submitLine` no-ops after exit instead of rejecting | RED 1 |
| M69 | `context-reset.ts` drops the `await` on `submitCommand` | RED 2 |
| M70 | `pool.ts` drops the `await` on `submitCommand` | RED 1 |
| M70b | PAIR: `pool.ts` reports a failure even when the submit SUCCEEDS | RED 1 |
| M71 | the fake ignores injected per-method failures | RED 4 |
| M72 | a successful `pane.close` does not record the closure in the fake | RED 2 |
| M73 | the fake's `holdMethod` does not actually hold | RED 1 |
| M76 | restore the presence-only outcome check (the original defect) | RED 9 |
| M77 | accept BOTH `result` and `error` | RED 1 |
| M78 | PAIR: over-strict — reject a legitimately empty `result:{}` | RED 1 (the control) |
| M79a–M79d | accept ONLY a string / null / array / number `error` | RED 1 each, its own row |
| M80a–M80d | accept ONLY a string / null / array / boolean `result` | RED 1 each, its own row |
| M81 | the assumed viewport is silent again | RED 1 |
| M81b | PAIR: warn even when the viewport WAS measured | RED 1 (the control) |
| M82 | warn on every poll instead of once | RED 1 |
| M83 | a malformed read is delivered as an EMPTY screen | RED 2 |
| M83b | PAIR: a malformed read latches, so the loop never recovers | RED 2 |
| M84 | the malformed read is silent again | RED 1 |
| M85 | the fake ignores `malformMethod` | RED 2 |
| M86 | restore the UNCONDITIONAL reset (the reported defect) | RED 1 |
| M86b | PAIR: never clear the flag, even while the child is ALIVE | RED 1 |
| M87 | reset first, then guard — ordering inverted | RED 1 |
| M88 | the fake stops failing in-flight calls on close | SURVIVED alone — see M88b |
| M88b | M88 **combined** with the host defect restored | GREEN with the bug present: the fake is the enabling condition |
| M89 | remove the post-close guard on `onBytes` (the reported defect) | RED 2 |
| M89b | PAIR: refuse bytes ALWAYS, not only after close | RED 53 |
| M90 | guard placed AFTER buffering — refuses to dispatch but still accumulates | RED 1 (the accumulation case alone) |
| M91 | MOVE `closed = true` below `failAll` (ordering only) | SURVIVED — the ordering is unobservable; see above |
| M92 | a refused subscribe keeps its handler registered | RED 1 |
| M93 | unregister on EVERY subscribe, not only the failed one | RED 3 |
| M94 | restore the quadratic append (`concat` per chunk) | RED 1 — only after the load was re-chosen by measurement |
| M95 | drop the unterminated bound on the fast path | RED 3 |
| M95b | PAIR: bound at `>=` so a frame exactly at the cap is rejected | RED 2 |
| M96 | keep a `subarray` VIEW of the tail instead of copying it | RED 1 |
| M96b | `retainedBytes` reports logical length, not allocation | SURVIVED alone — see M96c |
| M96c | M96b **combined** with the view restored | GREEN with the bug present: the accessor's fidelity is the enabling condition |
| M97 | the fail-open gate releases but says NOTHING | RED 1 |
| M97b | warn even when `beginOutput()` was called in time | SURVIVED alone — `beginOutput` clears the timer |
| M97c | M97b **combined** with `clearTimeout` removed (both guards off) | RED 1 (the control) |
| M98 | restore the bare settle on transport loss (the reported defect) | RED 2 |
| M98b | PAIR: never settle on transport loss, even when death IS confirmed | RED 4 |
| M99 | attempt the kill but do not confirm it | RED 1 |
| M100 | no escalation — SIGTERM only, never SIGKILL | RED 1 |
| M101 | a missing pid read as confirmed death | SURVIVED — branch unreachable; deleted, type tightened |
| M102 | EPERM counted as dead | SURVIVED alone → probe exported and tested → RED 1 |
| M102b | PAIR: every failed probe counted as ALIVE (ESRCH read as running) | RED 3 |
| M103 | signal without checking identity (the PID-reuse defect) | RED 1 |
| M103b | PAIR: never signal — treat every transport loss as already dead | RED 2 |
| M104 | no captured identity treated as confirmed death | RED 1 |
| M105 | identity compares existence only, ignoring the start time | RED 1 |
| M106 | start time parsed by absolute field index | SURVIVED (comm had no space) → parser extracted and tested → RED 1 |
| M107 | retain the delivered chunk in an extra field | SURVIVED — invalid: adds state the shape forbids |
| M108 | never shrink — keep the buffer at its high-water mark | RED 1 |
| M108b | PAIR: shrink always to the initial capacity (truncation) | SURVIVED until a large remainder existed → RED 1 |
| M109 | linear growth instead of doubling | RED 1 |
| M74 | restore `?? {}` — coerce any non-object `data` to an empty object | RED 5 |
| M74b | PAIR: over-strict — reject a genuinely EMPTY `data:{}` too | RED 1 (the control) |
| M75a | accept ONLY an absent `data` | RED 1 (its own case) |
| M75b | accept ONLY `data:null` | RED 1 (its own case) |
| M75c | accept ONLY an array `data` | RED 1 (its own case) |
| M75d | accept ONLY a string `data` | RED 1 (its own case) |
| M75e | accept ONLY a number `data` | RED 1 (its own case) |

M75a–M75e are the individual-case proof: each leaks exactly ONE shape past the guard
and reddens exactly that shape's row, so no case in the `data` table is redundant.
M74 is the defect restored (all five), M74b the over-strict twin.

M62/M62b bracket settlement from both sides — settling on failure and failing to settle
on success — and M63/M63b do the same for the kill flag; without the pair, "never latch"
is satisfied by a flag that is never set at all. M64 is the collapse case. M65b is the
one that needed thinking about: sending Enter first still sends both frames, so the call
log alone cannot tell the orders apart — what separates them is that a refused text must
leave the Enter UNSENT, because a blind Enter submits whatever the prompt already held.
M71–M73 mutate the FAKE rather than the code, which is the only way to show that the new
levers are load-bearing: if disabling `failMethod` or `holdMethod` changes nothing, the
tests that depend on them were passing for some other reason.

M58/M60 bracket the gate from both sides (ignored entirely, and never opened), M59 pins
the fail-open, and M61 is M56's terminated-frame twin: the at-limit case must hold on
both the terminated and unterminated paths.

M53/M54 and M55/M56 are the pairs, and M56 is the one worth naming: a bound that fires
at `>=` instead of `>` rejects a legitimate maximal frame, which is a new failure mode
rather than a fix, so the at-limit case is asserted as hard as the over case.

M48/M49 and M51/M52 are the pairs: a clock that never fires and one that fires on a
healthy connection both redden, and so do a SIGINT that latches and a terminal kill
that does not.

M42 is the root and M43–M45 are the three routes to it, each mutated separately so no
route can silently stop reaching the teardown. M47 is the pairing habit again: a
teardown that fires more than once reddens too, alongside the CONTROL that a healthy
exchange ends the socket zero times.

M38/M39 and M40/M41 are pairs in the same way M27/M28 and M30/M31 are: the
discrimination has to fire on the definite case and NOT on the indefinite one, so
both over- and under-applying it redden.

**M36 survived first, and fixing my test taught me what the defect actually was.**
I had assumed wrong per-line accounting would break the byte BOUND. It does not —
under-charging each removed line makes `size` fall too slowly, so the loop drops
MORE lines than needed. The bound holds; what is lost is RETENTION, and a ring that
discards screen a correct implementation would have kept can fall below the detector
window. The test now pins the maximal fitting tail (4 lines at 83 bytes fit under a
100-byte cap; 5 at 104 do not) rather than only the ceiling — a bound-only check
passes for an implementation that discards everything.

M30/M31 are a pair on the same reasoning as M27/M28: the cleanup must fire when a
pane exists and NOT when one does not, so removing it and over-applying it both
redden. M34 is the one that survived first and is described above.

**M26b SURVIVED, and the honest reading is that the mutation is inapplicable, not
that coverage is missing.** Run against `import-warm-session-reset.test.ts` — which
exercises the OTHER reset site, `pool.ts` — restoring the silent skip changes
nothing, because that fake supplies `writeKey`, so `submitCommand` reaches
`child.writeKey('enter')` either way. The writeKey-less case there is pinned by
`submitCommand`'s own test and end-to-end through `actuateSessionContextReset`.

I deliberately did NOT add an end-to-end test for the pool site's writeKey-less
case, because it could not discriminate. That path is wrapped in a catch that logs
and proceeds ("a clear failure must not strand the import"), so with a missing
`writeKey` the observable is: no clear happened, the turn ran anyway — which is
EXACTLY what the silent skip produced. The only difference the fix makes there is
that it is now logged rather than invisible, and a test asserting a stderr line is
brittle enough to be worse than the gap. Naming the limit is the honest option;
a test that passes before and after the fix would have been decoration.

M27 and M28 are a pair, and neither alone is a criterion: the clamp must bite at a
viewport of 800 **and** stay out of the way at 24, so removing it reddens the
boundary cases while over-applying it reddens the ordinary ones. A guard that simply
capped every request would pass M27's test and fail M28's.

### One latent trap found on the way out, and closed

`sendKey`/`sendKeys` (`signatures.ts:185-198`) degrade to `child.write(encodeKey(...))`
for a child that omits the F2 extensions. That fallback **cannot work under herdr**:
`encodeKey('enter')` is `\r`, and this backend's `write()` refuses `\r`. A detector
firing `['1','enter']` down the fallback would throw on the scan path rather than
press a key. It is unreachable in practice because `HerdrHost` always provides both
methods — but they are OPTIONAL on the interface precisely so fakes may omit them,
so nothing asserted it. It is now pinned by a test (and M24), and the docstrings at
`signatures.ts:179` and `keystrokes.ts:24` say why, having also been carrying
dangling citations to the deleted `bun-terminal-host.ts` (fixed here along with
`__tests__/pty-noise.test.ts:4`).

Two of these changed a test rather than only confirming it. M5b initially reddened
only siblings, because the flagship "the ring keeps a dead REPL's last output" case
fired `pane_exited`, which settled the child before the next poll and so pinned the
*event* rather than the read handling it claimed to pin; the case now kills the pane
without an event. And the pid-refusal case used `sleep: async () => {}`, which
starves the event loop rather than running fast — a zero-cost `await` never yields
to a macrotask — so it now sleeps 1 ms.
