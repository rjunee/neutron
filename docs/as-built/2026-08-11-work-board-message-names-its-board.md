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

### 5. A label that two boards answer to is not a name (round 4)

Naming the board is worthless if the name does not pick out ONE board. Three routes to an
ambiguous label were open after round 3, all of them demonstrated by running the shipped
resolver rather than reasoned about:

* **General vs a project called `General`.** `boardLabelForProjectId(null, …)` and
  `boardLabelForProjectId('general-project', () => 'General')` both returned the
  byte-identical `"General"`, and the rail was equally ambiguous — `ChatApp.tsx:1420`
  labels the General surface `General` while `:1432` renders `p.label`. So the ack named a
  board, the owner looked at his rail, and two rows answered. `disambiguateProjectBoardLabel`
  qualifies the PROJECT side to `General (project)` — the project is the side with an
  alternative, General being the fixed board every instance has. Case- and
  whitespace-insensitive on the flattened name, so `general`, `GENERAL ` and `General\n`
  all collide.

  Applied **server-side at every seam that produces an owner-facing name** —
  `boardLabelForProjectId` (acks, `<work_board>` block, `/status`), the rail's `label` on
  the `projects_changed` app-ws frame (`open/composer.ts` `readProjectRows`), and the
  `label` field on the HTTP project list (`gateway/http/app-projects-surface.ts`, both the
  solo and the shared half).

  **The HTTP half was missing, and the earlier version of this bullet asserted the
  opposite.** It claimed the rail label was server-computed and that "BOTH clients render it
  verbatim, so this fix needs no web/mobile change". Only WEB does: it reads the app-ws
  frame's `label` (`landing/chat-react/ChatApp.tsx` `p.label`). MOBILE lists over HTTP,
  which carried no `label` at all, so `app/app/projects/[id]/_layout.tsx` mapped `p.name`
  raw into the rail and rendered the undisambiguated name. On a phone the ack therefore
  named a board that no rail row answered to — the exact failure the rule exists to prevent,
  left in place by a doc that described the intended design as though it were the shipped
  one. The rule still has ONE implementation; what was missing was one of its two
  transports. Parity is now pinned by a test rather than by this paragraph
  (`gateway/__tests__/work-board-label-client-parity.test.ts`).

* **The 48-char cap collapsing two long names into one.** `projects.name` allows 1-128
  chars, so a head-only cap made any two names sharing a 47-char prefix render identically
  — and owner names are overwhelmingly prefix-shared with the distinguishing part at the
  END. `Q3 Financial Reporting and Compliance Review — Phase 1` and `… Phase 2` both capped
  to `Q3 Financial Reporting and Compliance Review — …`. `truncate` now elides the MIDDLE
  and keeps the tail. **Not a uniqueness guarantee, deliberately**: two names differing only
  inside the elided middle still collapse, and closing that needs a hash or an id suffix —
  neither of which is the owner's vocabulary, which is the requirement the label exists to
  satisfy. The old test pinned the cap's LENGTH, which a colliding cap satisfies perfectly;
  the new one asserts two long names yield two different labels.

* **The cap shattering the ZWJ emoji the sanitizer preserves.** Keeping the joiner through
  the flatten and then slicing by CODE POINT is a contradiction: `👨‍💻` is three code
  points, so `sanitizeBoardLabel('A'.repeat(46) + '👨‍💻 Dev')` published a bare `👨`. The
  cap is now grapheme-aware (`Intl.Segmenter`), so it can only cut BETWEEN glyphs.

* **The `renders as nothing` floor, defeated by its own guard.** The floor ran AFTER the
  cap and the cap splices in a VISIBLE `…`, so a name of 47+ joiners passed with visible
  content of exactly `"…"` and shipped as a board name — the `· <nothing>` ack the floor
  exists to prevent, delivered by the floor. Flooring the flattened-but-uncapped string
  asks the question of the owner's actual name.

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

* **The zero-row pane is STILL not explained.** Round 4 spent its diagnosis budget here
  and did not reproduce it. What it did do is narrow the field, so the next attempt starts
  further along. **Eliminated, each with a read:**

  * *An error rendering as empty.* Both clients have a DISTINCT error branch ahead of the
    zero-row branch — `landing/chat-react/WorkBoardTab.tsx:657` and
    `app/app/projects/[id]/workboard.tsx:328` (`testID="workboard-error"`, with a Retry).
    A failed list cannot render as "No work tracked yet" on either surface. The one
    swallowing path is a QUIET background poll, and it deliberately leaves the existing
    rows in place (`WorkBoardTab.tsx:355-359`) — it cannot zero a populated board.
  * *A wrongly-scoped live push zeroing the pane.* `fanWorkBoardChanged(run.project_slug)`
    looked like it was handing a trident-run identifier to a work-board keyed function, but
    a board-dispatched run's `project_slug` IS the board scope key —
    `open/composer.ts:2000` sets it to `workBoardScopeKey(project_slug, input.project_id)`.
    Writer and fan agree by construction.
  * *The bearer's owner slug diverging from the agent's.* The HTTP surface keys on
    `resolveBearer(...).project_slug`, and the app-ws resolver returns the GATEWAY's own
    configured slug on every path (`channels/adapters/app-ws/auth.ts:233,293,323`) — the
    same `project_slug` binding the composer hands `McpServer`. They cannot differ.
  * *A stale client-derived key at mount.* Both clients normalize every spelling of General
    through ONE shared module before it reaches a URL (`landing/chat-react/general-scope.ts`,
    `app/lib/general-scope.ts`), and the tab refetches on every `projectId` change
    (`WorkBoardTab.tsx:368-378`).

  **NOT eliminated — the one mechanism the code still supports.** The warm REPL's
  `/tool-call` sink resolves the write scope from the pool's session REGISTRATION
  (`runtime/adapters/claude-code/persistent/pool-state.ts:214`), and a lookup miss
  `?? null` degrades to the owner slug = General **by its own comment**, while the pane and
  the prompt block both derive from `turn.project_id`
  (`gateway/wiring/build-live-agent-turn.ts:1508`). A registration miss therefore writes to
  General while the owner watches a project pane. That remains a hypothesis: nothing here
  reproduced a miss. Closing it means threading the pool's resolved scope back into prompt
  composition, or asserting the two derivations agree — larger than this PR either way.

  There is also a mechanism this PR **cannot** rule out from code at all: the model
  claiming "added to the work board" in PROSE without calling `work_board_add`, in which
  case nothing was written anywhere and the pane is correctly empty. After this PR that
  case is at least DISTINGUISHABLE — a real write always emits a deterministic
  `▸ On the Work Board · <board>:` line from the tool layer, and prose alone emits none.
* **A project whose id ALREADY is `general`.** This bullet previously claimed the
  sentinel reservation was unfixed and out of the blast radius. **That was wrong, and it
  was wrong in the same commit that shipped the fix**: `slugifyProjectId` suffixes
  a name that would mint the sentinel
  (`onboarding/wow-moment/project-identity.ts`) and
  `tests/integration/work-board-ack-names-board.open.test.ts:387-388` asserts it. The doc
  described the state before the fix as though it were the state after — the folklore
  failure class this repo already has a record of, committed alongside its own refutation.

  What is genuinely **still open** is the part the reservation cannot reach: it guards
  future MINTING only. A project that already holds the id `general` keeps it, and
  `normalizeBoardProjectId` still collapses it onto the General bucket, so the two share
  one board. This is not hypothetical on the owner's box —
  `app/lib/project-rail-view.ts:37-41` records `GET /api/app/projects` returning
  `id: 'general'` there. The deep cause is that `general` is simultaneously the
  no-project SENTINEL (`build-live-agent-turn.ts:1508` sets `turn.project_id ?? 'general'`)
  and a legal project id, so at that seam the two are the same string and no normalizer
  can tell them apart. Fixing the storage collapse means changing the SENTINEL, not the
  normalizer — a larger change than this PR, and one that would undo the sentinel handling
  this PR just got right. **The owner-facing half IS fixed here**: the two boards no longer
  share a NAME (see below).

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

---

# Round 3 — closing the review findings

Argus's second round returned two blockers and a major. All three were real, and two of
them were about the same thing: **a guard that cannot fail is indistinguishable from a
guard that works.**

## Blocker 1 — the ack named the right board and delivered it to the wrong one

`General` arrives at the ack in four spellings, and the live path uses the one nobody
tested: the literal `'general'` sentinel. It starts at
`gateway/wiring/build-live-agent-turn.ts:1508` (`turn.project_id ?? 'general'`), rides the
warm-pool key into the REPL session (`runtime/adapters/claude-code/persistent/spawn.ts:186`),
and comes back out as the tool call's `project_id`
(`runtime/adapters/claude-code/persistent/pool-state.ts:214`).

Round 2 normalized that sentinel in the **label** (`boardLabelForProjectId` → `General`,
correct) but not in the **routing**: `tridentDeliveryChatId` tested
`projectId !== null && projectId.length > 0`, which the sentinel satisfies, so the ack was
filed under `app:<owner>:general` — a per-project topic the General surface never
subscribes to. **Correct label, undeliverable message.** The ack existed to stop a silent
chat and, on General, produced one wearing an accurate name.

The fix is one normalizer, `normalizeBoardProjectId` (`work-board/store.ts`), applied
ONCE per ack and threaded to both consumers (`work-board/chat-ack.ts`). `workBoardScopeKey`
now routes through it too, so the storage key and every owner-facing label agree on which
ids mean General by construction rather than by three copies of a three-way test.

**The same defect had a second, worse site.** `#339` stamps a board-bound build's
`chat_id` from `resolve_delivery`, called with the same raw `ctx.project_id`
(`trident/work-board-build-tool.ts:195,305`). A build started from General announced its
completion into the phantom topic — a **silent completion**, which is the exact bug `#339`
exists to prevent. Found only because a mutant survived; see below.

## Blocker 2 — the DB-to-name seam had no behavioural guard

Every existing test of the label supplied its own hand-built `{ id: name }` map, so the
mutant `project_name: (id) => id` — the composer handing the ack a lookup that echoes the
INTERNAL ID as the owner's board name, exactly what requirement (c) forbids — passed all of
them. A test that builds its own lookup tests the resolver; the **wiring** is what shipped
wrong.

`tests/integration/work-board-ack-names-board.open.test.ts` boots the real composer, the
real production graph and a real SQLite DB, inserts a real `projects` row, fires the
production-wired ack the composition exposes, and reads what a reloading client reads: the
persisted `app_chat_messages` row. That row carries both halves at once — `body` is the
text the owner sees, `topic_id` is the surface it reached. No ack internals are touched.

## Major — the single-mapping guard pinned a spelling and a count

Argus mutation-tested the guard itself and it lost. Three ways:

* `labelSites.length >= 3` meant a **fourth duplicate mapping made the guard greener**.
* It matched only the literal `?? 'General'`, so a backtick copy sailed through.
* Its comment-stripper deleted everything after `//` on any line — including `//` inside a
  string literal — hiding real code from every assertion.

It now asserts the invariant instead: `readProjectName` may only appear at its own
definition or as an argument to the shared resolver, so a second mapping is an offender
line no count can absorb; the General-literal check covers all three quoting styles; and
the stripper only removes comments that own the whole line (a false positive is visible, a
false negative is not).

## The two mutants that survived, and what they were hiding

Nine mutants, seven dead on the first pass. The two survivors were the useful ones.

**M2 — reverting `tridentDeliveryChatId` to the bare non-empty check: SURVIVED.** The ack
normalizes before calling the router, so the router's own bug is invisible from the ack
tests. That is not redundancy to delete — it is the `#339` delivery path above, reachable
through `resolve_delivery` with no ack involved. It now has a test at its own seam, and the
mutant dies.

**M5 — reverting the ack to `resolve_chat_id(input.project_id)`: SURVIVED.** Two correct
fixes masked each other: either one alone keeps the ack's topic right, so no end-to-end
assertion can tell them apart. The fix is to assert the **contract at the boundary that
owns it** — `work-board/chat-ack.test.ts` now checks what `resolve_chat_id` WAS HANDED, not
the topic string it returned.

📌 **A surviving mutant is not always weak coverage of the thing you were testing — twice
here it was a second, unguarded copy of the bug in a place the test could not see.**

## Minors, and one hole this round opened itself

* **Emoji names were being shattered.** `sanitizeBoardLabel` mapped all of `\p{Cf}` to a
  space, and ZWJ is in `\p{Cf}` — so a project named with a joined emoji sequence was
  acknowledged with that sequence split into two glyphs. Emoji names are first-class
  (`resolveProjectEmoji`), so the board named back to the owner did not match the rail:
  this PR's own defect, produced by its own hardening. ZWJ is now preserved; every other
  format char is still neutralized.
* **Which opened a hole.** A name of nothing but joiners is a NON-EMPTY string that renders
  as nothing, so it walked past a `length === 0` floor and produced a naming line with no
  board named. `sanitizeBoardLabel` now defines empty as "renders as nothing", so both
  floors catch it. *The exception you add to a guard is where the next gap lives.*
* **The fragment's missing floor.** `formatWorkBoardFragment` distrusts its caller's label
  by design but had no floor, so a blank one rendered `SAY WHICH BOARD — this one is .` —
  an instruction demanding a board name while supplying none. Floored to the same word the
  ack uses. No live caller reaches it; pinned because the next one will not.
* **A project named "General" could claim the sentinel.** `slugifyProjectId('General')`
  returned exactly `general`, so that project's board writes collapsed onto General while
  its acks read `General` — a truthful-looking name for the wrong board, undetectable.
  (Duplicate "General" projects are not hypothetical; see the note on
  `InMemoryProjectSettingsStore.get` in `gateway/http/app-projects-surface.ts`.) The id is
  now reserved at the one canonical slugifier, which closes every create path at once. The
  owner's chosen NAME is untouched; only the internal id shifts, and only for that word.
* **Two overstated as-built claims, narrowed.** `docs/AS_BUILT.md` said every owner-facing
  confirmation passes through `chat-ack.ts` — the agent also acknowledges in its own voice
  (`gateway/wiring/operating-doctrine.ts:65`), which no chokepoint constrains; and it said
  nothing on screen distinguished the scopes, which contradicted its own later paragraph
  (the panes ARE labelled; the message beside them was not).

## Known gap, stated rather than papered over

The deterministic ack is self-consistent by construction: the scope that picks its label is
the same `ctx.project_id` that scoped the write (`work-board/agent-tool.ts:218,251`), so it
cannot name a board other than the one it wrote to. The **agent's own prose** has no such
guarantee — it is guided by the `<work_board>` block, which is built from the composer's
`turn.project_id`, and on a pool-registration miss
(`runtime/adapters/claude-code/persistent/pool-state.ts:214` degrades to `null`) the write
would land on General while the block named a project. In that case the deterministic ack
says `General` and sits directly beside the agent's claim, so the disagreement is legible —
which is this PR's thesis, not an exception to it. Closing it properly means making the
tool dispatch's project binding unmissable, which is a runtime-seam change and NOT in this
PR.

## Deliberate tradeoffs

* **Board labels cap at 48 graphemes** (`MAX_BOARD_LABEL_LEN`) while the create surface
  allows 128, so a long project name elides in every ack and in `/status`. Chosen: the ack
  is one chat line and the item title needs the room.
* **`/status`'s `active_project` is a BOARD label, not a project field.** An id that no
  longer resolves prints `unknown project` rather than a name — deliberate, and the reason
  the line no longer carries its own `?? 'General'` fallback, which named the wrong board
  for an id it merely failed to resolve.

## Round 3 mutation results

**Nine mutants, nine dead** (after the two survivors above got the guards they were
missing). Each was applied to the production file, run against the real suite, and
reverted:

| Mutant | Killed by |
| --- | --- |
| `project_name: (id) => id` (the blocker-2 mutant) | integration, 3 failures |
| `tridentDeliveryChatId` back to the bare non-empty check | integration (delivery seam) |
| `boardLabelForProjectId` skips the normalizer | `chat-ack.test.ts`, 2 failures |
| slug reservation removed | integration (drift guard) |
| ack routes the un-normalized id | `chat-ack.test.ts`, 3 failures |
| ZWJ shattered again | `chat-ack.test.ts`, 2 failures |
| fragment floor removed | `fragment.test.ts`, 2 failures |
| `workBoardScopeKey` skips the normalizer | `store.test.ts`, 2 failures |
| a second General mapping, written with backticks | the rewritten wiring guard |

The last one is the mutant that **survived round 2's guard** and is the reason the guard was
rewritten to assert an invariant instead of a count.

## UI scope — still message-only, and why

Unchanged from round 2 and reaffirmed: the panes are already labelled
(`landing/chat-react/ChatApp.tsx:1417-1434`), so the missing information was in the
MESSAGE, not the panel. A cross-client parity test would pin a scope badge that the
defect never needed. If the owner wants the Work pane to restate its scope in its empty
state, that is a separate, additive change.
