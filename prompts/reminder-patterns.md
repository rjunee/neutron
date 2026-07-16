<!--
Template prompt. Owner-scoped filesystem paths are written as the
{{OWNER_HOME}} template variable and resolved at load time by
@neutronai/prompts/template.ts.
-->

# Reminder Patterns Library

Reusable instruction blocks for building smart reminders. Copy a pattern into the `message` field of a `POST /reminders` request (or into a `/remind` natural-language request that the skill expands), fill in the `FILL:` placeholders, and you have a production-ready smart reminder without rebuilding the orchestration from scratch every time.

These patterns work on top of `prompts/reminder-agent-base.md` (voice, rules, output contract). Every reminder already inherits the base voice; these patterns add the **domain-specific composition logic** on top. Each pattern is pure composition guidance for the fire-time agent — the agent only reads workspace files and outputs the message text, and the gateway owns delivery and the reminder's schedule/lifecycle.

---

## Pattern index

| Pattern | Cadence | Lifecycle | Use for |
|---|---|---|---|
| [nag-until-done](#pattern-nag-until-done) | Recurring | Fires until disabled; nudges toward a file-detectable completion | Trade-show planning, book drafts, deal closures, contractor bids |
| [escalating-urgency](#pattern-escalating-urgency) | Recurring | Fires until disabled; tone escalates as the deadline nears | Tax filing, passport renewal, contract signing |
| [daily-countdown](#pattern-daily-countdown) | Daily | Naturally winds down once the event passes | Anniversary prep, trip departure, product launch |
| [check-in-cadence](#pattern-check-in-cadence) | Recurring | Fires until disabled; asks a habit question each time | Habit formation, therapy homework, weekly review |
| [context-aware-one-shot](#pattern-context-aware-one-shot) | One-shot | Auto-deletes after firing once | Meeting prep, trip day-of, milestone nudges |

---

## Pattern: nag-until-done

**When to use:** recurring reminder with a clear completion signal that can be detected by reading a file. Nudges toward the goal each time it fires; when the goal looks done, it congratulates instead.

**Required inputs:**
- `TAG`: distinctive tag (e.g. `canton-fair-acme`). Must appear verbatim in the message body so the reminder is easy to find and manage.
- `GOAL`: one-sentence description of what "done" means in plain English.
- `CHECK_PATHS`: list of file globs to read for completion evidence.
- `CHECK_CRITERIA`: what to look for in those files ("a `booked: true` line", "any mention of flights confirmed", etc.)
- `NEXT_ACTION_BANK`: 5-10 specific next-actions to cycle through so daily nudges don't repeat.
- `DEADLINE` (optional): absolute date, so the agent can frame urgency and handle the post-deadline case.

**Template — paste into reminder `message`:**

```
PATTERN: nag-until-done
TAG: FILL:<distinctive-tag>
GOAL: FILL:<one-sentence description of what done looks like>

CONTEXT (human-readable, for nudge composition):
FILL:<2-5 lines of relevant background so each nudge can reference it>

CHECK_PATHS: FILL:<file globs to read, e.g. {{OWNER_HOME}}/Projects/acme/STATUS.md, {{OWNER_HOME}}/Projects/acme/*canton*.md>
CHECK_CRITERIA: FILL:<what indicates done — "trip booked", "flights confirmed", "status: complete">

Compose one crisp 1-3 sentence nudge toward the GOAL:
1. Read CHECK_PATHS (those that exist) with your read tools and judge them against CHECK_CRITERIA.
2. If the goal is clearly done, compose ONE short congratulatory line acknowledging it, and stop.
3. If NOT done, compose a nudge that:
   - references how many days remain until FILL:<DEADLINE or event> (from the current date you were given),
   - picks ONE specific next action from this bank, varying it across days so nudges don't repeat:
     1. FILL:<action 1>
     2. FILL:<action 2>
     3. FILL:<action 3>
     4. FILL:<action 4>
     5. FILL:<action 5>
   - follows the base voice rules (short, no preamble, no em dashes, action-oriented).
4. DEADLINE PASSED: if the current date is after FILL:<DEADLINE> and nothing in CHECK_PATHS shows completion, compose: "FILL:<event> was N days ago and I don't see it recorded as done, is it? Let me know and I'll close this out."
```

**Real-world shape:** a Canton Fair prep reminder cycles a 10-item next-action bank (dates, badge, suppliers, hotel, brief, flights, factory visits, translator, NDA, sample-order) and reads `Projects/acme/STATUS.md` + `*canton*` files for completion evidence.

---

## Pattern: escalating-urgency

**When to use:** deadline-driven task where tone must shift from gentle → insistent → urgent as the deadline approaches. Unlike `nag-until-done`, the same action is usually needed throughout — only the framing escalates.

**Required inputs:**
- `TAG`: distinctive tag
- `TASK`: what needs to be done (one sentence)
- `DEADLINE`: absolute date
- `CHECK_PATHS`: files to read for completion evidence
- `CHECK_CRITERIA`: what "done" looks like

**Template:**

```
PATTERN: escalating-urgency
TAG: FILL:<distinctive-tag>
TASK: FILL:<what needs doing>
DEADLINE: FILL:<YYYY-MM-DD>
CONTEXT: FILL:<why this matters, what's at stake if missed>

CHECK_PATHS: FILL:<files to read for completion evidence>
CHECK_CRITERIA: FILL:<what done looks like>

Compose the nudge:
1. Read CHECK_PATHS with your read tools. If CHECK_CRITERIA is met, compose ONE line acknowledging TASK is done, and stop.
2. Otherwise compute days_until = DEADLINE - today (from the current date you were given) and set the TONE by how close it is:
   - >14 days: gentle, 1 sentence. "FILL:<task> is on the radar for FILL:<deadline>, N weeks out."
   - 7-14 days: specific, 2 sentences with the next concrete action.
   - 3-6 days: direct, 2-3 sentences, name the specific blocker. "FILL:<task> is N days out. Main blocker is FILL:<X>. Can you resolve it today?"
   - 1-2 days: urgent, 3 sentences, acknowledge the crunch. "FILL:<task> is tomorrow. You planned to FILL:<X>. If it's not happening, do FILL:<fallback>."
   - 0 days (day-of): single urgent ping. "Today. FILL:<task>. Last chance."
   - past deadline: "FILL:<task> was due N days ago, is it done?" and keep the tone urgent until it's resolved.
3. Follow the base voice rules (short, no em dashes, action-oriented).
```

**Example seeds:** annual tax filing (Mar 1 → Apr 15), passport expiry (6 months out → 1 month → week → day-of), life insurance renewal.

---

## Pattern: daily-countdown

**When to use:** a future event with a fixed date where each day's nudge is a distinct piece of prep work leading up to it. Simpler than `escalating-urgency` because there's no "done" check — the reminder just naturally winds down when the event passes.

**Required inputs:**
- `TAG`
- `EVENT_NAME`
- `EVENT_DATE`
- `DAILY_SCRIPT`: ordered list of N items, one per day leading up to the event. Day -N is item 1, day-of is the last item.

**Template:**

```
PATTERN: daily-countdown
TAG: FILL:<distinctive-tag>
EVENT: FILL:<event name>
EVENT_DATE: FILL:<YYYY-MM-DD>

DAILY SCRIPT (compose the item matching today's offset from EVENT_DATE):
- T-7: FILL:<prep item for 1 week out>
- T-5: FILL:<prep item>
- T-3: FILL:<prep item>
- T-2: FILL:<prep item>
- T-1: FILL:<day before>
- T+0: FILL:<day-of message>

Compose the nudge:
1. Compute offset = today - EVENT_DATE (negative = days until) from the current date you were given.
2. If today's offset matches an entry above, compose that item as a short nudge.
3. If today's offset falls between entries, use the most recent earlier entry and frame it around the days remaining.
4. If the event has already passed, compose a single "FILL:<event> was recently, how'd it go?" line.
5. Always produce a message — delivery is automatic and you cannot skip a day. Follow the base voice rules: short, no em dashes, no preamble.
```

**Example seeds:** anniversary prep (gift → dinner reservation → flowers → day-of message), product launch countdown, trip departure prep.

---

## Pattern: check-in-cadence

**When to use:** habit formation or open-ended goals where "done" is fuzzy and needs the user's explicit input. The agent asks a question; the user's answer comes back through the chat topic and is handled separately.

**Required inputs:**
- `TAG`
- `HABIT_NAME`
- `QUESTION`: the single question to ask each check-in
- `LOG_FILE`: path where prior answers are recorded (so future fires can read the trajectory)

**Template:**

```
PATTERN: check-in-cadence
TAG: FILL:<distinctive-tag>
HABIT: FILL:<what habit>
QUESTION: FILL:<single question>
LOG_FILE: FILL:<absolute path, e.g. {{OWNER_HOME}}/Projects/biohacking/checkin-log.md>

Compose the check-in:
1. If LOG_FILE exists, read the last few entries with your read tools to understand the recent trajectory.
2. Compose a check-in that:
   - references the recent trajectory briefly ("3 in a row this week" / "been a few days"),
   - asks the QUESTION directly,
   - fits the base voice (short, specific, no em dashes).
The user's reply arrives through the chat topic and is handled there — you only compose the question. You do not wait for a reply and you do not record the answer.
```

**Example seeds:** daily meditation check-in, weekly therapy homework review, monthly financial reflection.

---

## Pattern: context-aware-one-shot

**When to use:** single-fire reminder where the MESSAGE content should be composed fresh at fire time from current on-disk state, not pre-written at creation time. One-shots auto-delete after firing, so there's no ongoing lifecycle to manage.

**Required inputs:**
- `TOPIC`: what the reminder is about
- `CONTEXT`: which on-disk project state to read
- `OUTPUT_SHAPE`: what the final posted message should look like

**Template:**

```
PATTERN: context-aware-one-shot
TOPIC: FILL:<short topic>

CONTEXT: FILL:<what on-disk project state is relevant, e.g. {{OWNER_HOME}}/Projects/<slug>/STATUS.md>
OUTPUT_SHAPE: FILL:<what the final message should look like, e.g. "names the next milestone and suggests one concrete step">

Compose the message:
1. Read the CONTEXT files with your read tools, plus the current date and time you were given.
2. Compose a fresh message in OUTPUT_SHAPE from that context. Do not reference context you could not actually read.
3. Follow the base voice rules (short, no em dashes, action-oriented).
```

**Real-world shape:** a trip day-of nudge that reads the trip's STATUS.md and names the one thing still open before departure.

---

## Composing reminders that use these patterns

Two ways to apply a pattern:

**1. Manual `POST /reminders`:** copy the template into the `message` field, fill the `FILL:` slots, submit to the gateway. The gateway stores the block verbatim; at fire time the reminder engine classifies it as a `pattern` shape and composes from it.

**2. Via the `/remind` skill natural language:** say "nag me until the trade-show trip is booked" and the skill recognizes the pattern-matching phrase, looks up the `nag-until-done` template, asks for the minimum fields it needs, and creates the reminder.

## Adding a new pattern

1. Identify a pattern you've used ad-hoc twice — that's the trigger to formalize it. Don't generalize from a single use.
2. Add it to the table at the top of this file.
3. Add a full section below with Required inputs + Template + example.
4. Keep it pure composition guidance: the fire-time agent only reads files and outputs message text. If a pattern needs a new context source, add it behind the reminder engine's context seam, not into the prompt.
5. Register the new name alongside the code: `KNOWN_REMINDER_PATTERNS` in `reminders/message-shape.ts` and `REMINDER_PATTERN_NAMES` in `@neutronai/reminders-core/smart-wrap`.
6. Commit with a `docs(prompts): add <pattern-name> reminder pattern` message.

## Rules

- **Patterns compose, they don't override.** Every reminder, regardless of pattern, inherits the base voice rules from `reminder-agent-base.md`. If a pattern template contradicts the base, the base wins.
- **The agent only composes.** A pattern block is guidance for composing the message text. It never instructs the agent to post, delete, schedule, or take any external action — the gateway owns delivery and the reminder's lifecycle.
- **Distinctive tags help management.** A `TAG:` substring uniquely present in the message body makes a reminder easy to find, edit, or disable later. Include a `TAG:` line in any recurring pattern.
- **Patterns are prompts, not code.** These are instructions for the LLM agent composing the reminder. They can be as expressive as natural language allows. If a pattern gets too complex to express in prose, that's a signal the reminder system needs new primitives — add them to the engine, don't cram them into the prompt.
