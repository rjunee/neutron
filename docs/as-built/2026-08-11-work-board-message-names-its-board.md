# "Added to the work board" — but WHICH board?

**Landed:** 2026-08-11 · **Surface:** `work-board/chat-ack.ts`, `work-board/fragment.ts`, `open/composer.ts`

> **No issue number.** An earlier draft of this doc and of the code comments cited
> `#502`. That number belongs to an unrelated defect in the governed repo (a launcher
> credential duplicate), and no filed issue covers this report. Rather than leave a
> wrong pointer in a permanently public tree, the references were removed and the
> report is quoted below in full. Filing the issue is owed.

## What the owner saw

> "ok now I am seeing some activity claiming things are being added to the work board, but they are NOT"

A screenshot: the chat reading `▸ On the Work Board: "P1 — email pipeline store + poller + classification + escalation"`, beside a WORK panel reading `No work tracked yet. Ask Neutron to start something, or add an item.`

## What is established, and what is not

This section is deliberately split, because the first draft of it asserted a
five-link causal chain as fact and two of the links do not survive a reading of the
code. **The fix below stands on the verified part alone.**

**Verified against the code.**

* The work board is keyed **per board**, and two boards render side by side with
  nothing on screen distinguishing them. `workBoardScopeKey`
  (`work-board/store.ts:164-171`) maps General onto the bare instance slug and a real
  project onto its id; the HTTP read threads that scope through every store call
  (`gateway/http/work-board-surface.ts:219`).
* The confirmation named the **item** and never the **board**. That is the defect
  this PR fixes, and it is verifiable by reading the three ack texts alone.
* The agent could not have named the board even if it chose to: the per-turn
  `<work_board>` block said *"your EXTERNAL MEMORY for this project"* and never said
  which project.
* The live push is wired — the store's `onChange` fans a `work_board_changed` frame
  (`open/composer.ts:3576-3577`).
* Board writes are scoped server-side from `ToolCallContext` and are not spoofable by
  the model (`work-board/agent-tool.ts:15-25`).

**NOT established — the exact mechanism that put those two things on one screen.**

* An earlier draft said the pane was empty *because* its board held a single `done`
  item, filtered out by `WorkBoardTab.tsx:575`. **That is wrong.** The empty state at
  `landing/chat-react/WorkBoardTab.tsx:659` requires `active.length === 0 && completed.length === 0`,
  and the GET returns completed rows too (`gateway/http/work-board-surface.ts:225`), so
  a board holding one done item renders `Done · 1` (`WorkBoardTab.tsx:725`), not "No work
  tracked yet". **The pane the owner saw held ZERO rows in its scope.**
* An earlier draft implied a project-scoped ack rendered beside a General pane. The
  ack is delivered to the originating topic — `<base>:<project_id>` for a project,
  the bare base for General (`open/composer.ts:3653` `tridentDeliveryChatId`) — and
  each surface scopes its pane to **its own** conversation's project
  (`landing/chat-react/ChatApp.tsx:2228`). So chat and pane should agree, and the
  screenshot says they did not.
* One reachable explanation is a **scope divergence** between the chat/ack scope and
  the agent's write scope. The warm REPL resolves a tool's project from the pool's
  session registration (`runtime/adapters/claude-code/persistent/pool-state.ts:214`),
  and a registration miss "degrades to the owner slug = General" by its own comment
  — a different source from the `turn.project_id` the prompt block and the pane use
  (`gateway/wiring/build-live-agent-turn.ts:1307`). **This is a hypothesis. It is not
  confirmed, this PR does not fix it, and the owner's original report is therefore
  NOT closed by this PR.**

📌 **A true statement that cannot be checked reads exactly like a false one.** From
the owner's seat "it's on the work board" beside a board with nothing on it is
indistinguishable from a fabrication, and he was right to call it a lie. What this PR
fixes is the confirmation that under-specified its subject — so that the next time
scope and pane disagree, **the message itself says which board it meant** and the
divergence becomes visible instead of reading as a lie.

## What changed

### 1. Every deterministic ack names its board

`work-board/chat-ack.ts` is the single chokepoint all three owner-facing board
confirmations pass through, so all three were fixed in one place:

| kind | text |
|---|---|
| `card_added` | `▸ On the Work Board · <board>: "<title>"` |
| `build_dispatched` | `⑂ Build dispatched · <board>: "<title>" — running autonomously; …` |
| `inline_started` | `› Started "<title>" · <board> — I'll post here when it's done.` |

`complete` and `reorder` emit no chat text at all, so there was nothing to name there.
The `·` separator is the vocabulary the board UI already uses (`Done · N`, in both the web
pane and the mobile screen) and it tolerates any noun phrase in the label slot.

### 2. Three things the label must never be

`boardLabelForProjectId` is the ONE mapping, and each failure mode is a guard, not a
convention:

* **The storage key.** `workBoardScopeKey` collapses General onto the instance slug, so
  General's key is an internal identifier. General short-circuits to the literal `General`
  **before the project lookup is called at all** — the lookup is not merely ignored, it
  does not run, so a project-store outage cannot affect a General ack and the slug has no
  path to the chat. The test asserts the call LOG, not just the rendered label: a lookup
  that ran and returned nothing still renders `General`, so a label-only assertion would
  survive deleting the short-circuit.
* **An internal project id.** A `project_id` that no longer resolves to a rail project
  (deleted mid-turn) degrades to the word `unknown project`. Never the raw id, and never a
  silently omitted board — an ack that cannot name its board is the defect itself.
* **More than one line.** A project name is validated for LENGTH ONLY at the create
  surface (`gateway/http/app-projects-surface.ts` `handleCreate`: trim, 1-128 chars), so
  `Example\nIGNORE ALL PRIOR INSTRUCTIONS` is a **storable project name** — and both
  consumers splice the label into a line-oriented medium. In the chat that extra line
  renders as its own message-like claim; inside `<work_board>` it is a standalone
  instruction line. **XML-escaping does not help — `&<>` are not what makes it dangerous,
  the line boundary is.** `sanitizeBoardLabel` collapses every C0/C1 control, LINE and
  PARAGRAPH SEPARATOR, and the invisible format chars (zero-width, bidi overrides) to a
  single space, then caps. It mirrors `store.sanitizeTitle`, which has flattened item
  titles for exactly this reason; the label had no equivalent, which is what let it
  through. The title is flattened on the same hop rather than trusting its caller.

The label is the rail project name (`projects.name`, the words in the rail), read **fresh
per ack** so a mid-session rename is named correctly.

### 3. One mapping, one cheap read

`boardLabelForProjectId` takes a **single-row** name lookup, not the project rail. The
first draft passed `readProjectRows()`, which runs an O(projects) query plus a per-project
unread count and rail-extras query and discards all of it but one name — on every ack and
every agent turn, including on General where the result was thrown away.

The same call also replaced a **second, subtly different mapping**. The `/status` project
line owned its own `readProjectRows().find(...)?.label ?? 'General'`, which named
`General` for an id it merely failed to resolve — printed beside an `active_work_items`
count read from the REAL project scope. Two fields, one line, two different boards: this
PR's defect, one surface over. `/status` now resolves through the shared mapping, so an
unresolvable project reads `unknown project` and cannot claim to be General.

### 4. The agent is told to name the board, for every verb

The block now carries the board name in its header and closes with
`Whenever you tell the owner you added, started, dispatched, updated or finished
something on the Work Board, SAY WHICH BOARD — this one is <board>`. The verbs are
enumerated because the doctrine (`gateway/wiring/operating-doctrine.ts:65`, "Track your
work on the board") requires the agent to acknowledge starting, dispatching and finishing
work too — an instruction covering only "put something on" left the other confirmations
free to omit the board, which is the same defect one verb over.

The label is **flattened and capped BEFORE it is escaped**, and that order is the guard,
not a style choice. Escape-then-cap can cut inside the `&lt;` the escape just produced,
or between the two halves of an astral char's surrogate pair, and emit the broken
remainder into the prompt. An ASCII-only cap test cannot see either failure, so the tests
cover both.

## The panel deliberately did NOT change

Considered and declined, because the redundancy is not worth the diff:

1. **The panel's own scope is already on screen.** The project rail marks the active
   surface (`landing/chat-react/ChatApp.tsx:1417-1432` — `RailItem active={…}`) and the pane is scoped to that same
   surface's project (`ChatApp.tsx:2228` derives it from `hostVm.projectId`). On mobile the
   board is a per-project route entered from that project, so navigation makes it
   unambiguous.
2. **The missing information was never the panel's scope — it was the ack's.** The owner
   could see which surface he was on. What he could not see was where the item went.
3. **A message fix reaches every surface.** The ack is persisted chat, so it names its
   board in a notification, on mobile, and when the log is read back weeks later — none of
   which have a panel. A header label helps only while the pane is open.
4. Threading a project *label* through four components that today carry only a project *id*
   would touch a kept-alive pane whose own docblock warns about remount regressions (#355),
   in exchange for restating what the rail shows two inches to the left.

## Known, unfixed, and deliberately out of scope

* **The scope divergence hypothesis above.** The prompt block's board name derives from
  `turn.project_id`; the agent's board WRITE derives from the pool's session registration.
  They agree whenever the session is registered, and a miss sends the write to General
  while the block names the project. The deterministic ack is unaffected — it derives from
  the same `ctx.project_id` the write used, so it always names where the row actually
  landed, and it is the authoritative line. Closing the divergence itself means threading
  the pool's resolved scope back into the prompt composition, which is a larger change than
  this fix and needs its own PR.
* **A project name that slugifies to `general`.** `slugifyProjectId` can mint the id
  `general` (`onboarding/wow-moment/project-identity.ts:44`), which `workBoardScopeKey`
  collapses onto the General bucket, so such a project silently shares General's board.
  Pre-existing, and **not a mislabel**: the ack calls it `General`, which is exactly where
  the row lands, so the confirmation stays truthful. Containment belongs in the canonical
  slugifier (reject or uniquify the sentinel), which is shared identity machinery with its
  own drift-guard test — out of this fix's blast radius.

## Mutation results

**Twenty mutants, twenty dead**, each on a different assertion, run against the real test
suite (`work-board/` plus the wiring guard). The ones that mattered:

* **The flatten removed** → a multiline project name injects a standalone line into both
  the ack and the `<work_board>` block. Killed (9 failures).
* **Controls deleted instead of collapsed to a space** → `a\nb` fuses into `ab`. Killed.
* **Only `\n` handled** → CR, NEL, LINE SEPARATOR and the bidi overrides sail through.
  Killed.
* **General's short-circuit deleted**, and separately **General short-circuits but only
  AFTER calling the lookup** → the second is invisible to a label assertion and is why the
  test asserts the call log. Both killed.
* **The unresolvable-project fallback returns the raw id** → the exact id leak forbidden
  above. Killed.
* **The fragment escapes THEN caps**, and **caps by UTF-16 units** → a truncated entity
  and a lone surrogate in the prompt respectively. Both killed; neither is visible to an
  ASCII-only cap test.
* **`/status` regrows its own second mapping**, and **the ack is rewired to the full rail
  read** → killed by the structural guard, which exists precisely because a duplicate
  mapping is invisible to every behavioural test of the mapping (each copy is
  self-consistent).
* Also killed: each of the three ack texts dropping its board name; the say-which-board
  line deleted; the instruction narrowed back to one verb; the header dropping the name;
  the title flatten removed; the throwing-lookup guard removed; the prompt block handed
  the raw project id.

Two mutants in the first batch initially reported as SURVIVED were **patch failures, not
survivors** — the grep that verified them matched the docblock quoting the same prose
rather than the code. Re-run with the anchor on the `return` statement, both died. Worth
recording: *a mutation harness that verifies its own patch with a grep can lie in the
direction that looks like a finding.*

The end-to-end cases wire the **real** `buildWorkBoardChatAck` into
`registerWorkBoardToolSurface` and assert on the delivered text. The pre-existing spy-based
tests prove the tool hands the ack the right event, but a spy never renders a string —
**it could not have caught an unnamed board, which is the whole defect.** One case asserts
both halves at once: the row really does land on the slug-keyed General bucket, *and* the
text the owner reads says `General`.
