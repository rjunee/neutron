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
