<!--
Template prompt. Owner-scoped filesystem paths are written as the
{{OWNER_HOME}} template variable and resolved at load time by
@neutronai/prompts/template.ts.
-->

# Reminder Patterns Library

Reusable instruction blocks for building smart Nova reminders. Copy a pattern into the `message` field of a `POST /reminders` request (or into a `/remind` natural-language request that the skill expands), fill in the `FILL:` placeholders, and you have a production-ready smart reminder without rebuilding the orchestration from scratch every time.

These patterns work on top of `prompts/reminder-agent-base.md` (voice, rules, how-to-post, self-delete contract). Every reminder already inherits the base voice and the self-delete mechanism; these patterns add the **domain-specific orchestration logic** on top.

---

## Pattern index

| Pattern | Cadence | Stop condition | Use for |
|---|---|---|---|
| [nag-until-done](#pattern-nag-until-done) | Recurring | File/status check + self-delete | Canton Fair planning, book drafts, deal closures, contractor bids |
| [escalating-urgency](#pattern-escalating-urgency) | Recurring | Deadline passes or self-delete | Tax filing, passport renewal, contract signing |
| [daily-countdown](#pattern-daily-countdown) | Daily | Event passes or self-delete | Wedding anniversary prep, trip departure, product launch |
| [check-in-cadence](#pattern-check-in-cadence) | Recurring | Explicit "yes, done" or N negative responses | Habit formation, therapy homework, weekly review |
| [context-aware-one-shot](#pattern-context-aware-one-shot) | One-shot | Fires once then auto-deletes | Weather-sensitive nudges, meeting prep, trip day-of |

---

## Pattern: nag-until-done

**When to use:** recurring reminder with a clear completion signal that can be detected by reading a file. Fires daily until the signal appears, then posts a farewell and self-deletes.

**Required inputs:**
- `TAG`: distinctive tag for self-lookup (e.g. `canton-fair-acme`). Must appear verbatim in the message body.
- `GOAL`: one-sentence description of what "done" means in plain English.
- `CHECK_PATHS`: list of file globs to read for completion evidence.
- `CHECK_CRITERIA`: what to look for in those files ("a `booked: true` line", "any mention of flights confirmed", etc.)
- `NEXT_ACTION_BANK`: 5-10 specific next-actions the agent can cycle through so daily nudges don't repeat.
- `DEADLINE` (optional): absolute date, agent will adjust urgency and handle post-deadline edge case.

**Template — paste into reminder `message`:**

```
PATTERN: nag-until-done
TAG: FILL:<distinctive-tag>
GOAL: FILL:<one-sentence description of what done looks like>

CONTEXT (human-readable, for nudge composition):
FILL:<2-5 lines of relevant background so each nudge can reference it>

TASK: Each morning, compose a crisp 1-3 sentence nudge for Sam and post to General via:
    bash {{OWNER_HOME}}/scripts/tg-post.sh {{TELEGRAM_CHAT_ID}} "" "<your nudge>"

Before composing the nudge, CHECK FOR COMPLETION:
1. Read these paths if they exist: FILL:<list of file globs, e.g. {{OWNER_HOME}}/Projects/acme/STATUS.md, {{OWNER_HOME}}/Projects/acme/*canton*.md>
2. Look for: FILL:<what indicates done — "trip booked", "flights confirmed", "status: complete", etc.>
3. If clearly done:
   - Post: "✓ FILL:<short congratulatory line> — removing this daily nag."
   - Find your ID and DELETE yourself per the base prompt's self-delete contract (tag: FILL:<tag from above>)
   - Exit

If NOT done, compose a nudge that:
- References how many days until FILL:<DEADLINE or event> (compute from `date +%Y-%m-%d`)
- Picks ONE specific next action from this bank, cycling across days to avoid repetition:
  1. FILL:<action 1>
  2. FILL:<action 2>
  3. FILL:<action 3>
  4. FILL:<action 4>
  5. FILL:<action 5>
- Follows the base prompt rules (short, no preamble, no em dashes, action-oriented)

EDGE CASE — DEADLINE PASSED: if today is after FILL:<DEADLINE> and no completion was detected, post:
    "⚠️ FILL:<event> was N days ago and no completion was recorded — did this happen? Reply and I'll close this out or keep nagging."
Do NOT auto-delete on missed deadline. Sam will decide manually.
```

**Real-world example (Canton Fair Acme glass bottles):** see reminder `cee67160-...` in `reminders.json`. That reminder cycles through a 10-item next-action bank (dates, badge, suppliers, hotel, brief, flights, factory visits, translator, NDA, sample-order) and checks `Projects/acme/STATUS.md` + `*canton*` files for completion.

---

## Pattern: escalating-urgency

**When to use:** deadline-driven task where tone must shift from gentle → insistent → urgent as the deadline approaches. Unlike `nag-until-done`, the same action is usually needed throughout — only the framing escalates.

**Required inputs:**
- `TAG`: distinctive tag for self-lookup
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

Each morning:
1. Check for completion: read FILL:<file paths>. If FILL:<criteria>, post "✓ FILL:<task> done — clearing this one." and self-delete (tag: FILL:<tag>).
2. Otherwise compute days_until = DEADLINE - today.
3. Pick TONE based on days_until:
   - >14 days: gentle reminder, 1 sentence. "FILL:<task> is on the radar for FILL:<deadline> — N weeks out."
   - 7-14 days: specific nudge, 2 sentences with the next concrete action.
   - 3-6 days: direct, 2-3 sentences, name the specific blocker. "FILL:<task> is N days out. Main blocker is FILL:<X>. Can you resolve it today?"
   - 1-2 days: urgent, 3 sentences, acknowledge the crunch. "FILL:<task> is tomorrow. You said you'd FILL:<X>. If it's not happening, do FILL:<fallback>."
   - 0 days (day-of): single urgent ping. "Today. FILL:<task>. Last chance."
   - <0 days (missed): post "⚠️ FILL:<task> was due N days ago — did it happen?" and keep nagging until Sam confirms or cancels. Do NOT auto-delete.
4. Post via `bash {{OWNER_HOME}}/scripts/tg-post.sh {{TELEGRAM_CHAT_ID}} "" "<your nudge>"`
```

**Real-world example seeds** (not yet created): annual tax filing reminder (Mar 1 → Apr 15), passport expiry (6 months out → 1 month → week → day-of), life insurance renewal.

---

## Pattern: daily-countdown

**When to use:** a future event with a fixed date where each day's nudge is a distinct piece of prep work leading up to it. Simpler than `escalating-urgency` because there's no "done" check — the reminder just naturally expires when the event passes.

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

DAILY SCRIPT (agent picks the item matching today's offset from EVENT_DATE):
- T-7: FILL:<prep item for 1 week out>
- T-5: FILL:<prep item>
- T-3: FILL:<prep item>
- T-2: FILL:<prep item>
- T-1: FILL:<day before>
- T+0: FILL:<day-of message>

Each morning:
1. Compute offset = today - EVENT_DATE (negative = days until)
2. If offset is in the script above, post the matching item via tg-post.
3. If offset > 0 (event passed), post "FILL:<event> was yesterday — how'd it go?" ONE TIME, then self-delete (tag: FILL:<tag>). Don't keep nagging after the event.
4. If offset is not in the script (e.g. T-6 with no script entry), do nothing this day — exit silently.

Follow base voice rules: short, no em dashes, no preamble.
```

**Real-world example seeds:** wedding anniversary prep (gift → dinner res → flowers → day-of message), product launch countdown, trip departure prep.

---

## Pattern: check-in-cadence

**When to use:** habit formation or open-ended goals where "done" is fuzzy and requires Sam's explicit input. The agent asks a question, logs the answer somewhere, and adjusts future cadence based on the response.

**Required inputs:**
- `TAG`
- `HABIT_NAME`
- `QUESTION`: the single question to ask each check-in
- `LOG_FILE`: path to append answers to (so future fires can read prior responses)
- `ESCALATION_RULE`: how to adjust cadence based on answers (e.g., "3 misses in a row → switch to twice-weekly", "5 yesses in a row → self-delete")

**Template:**

```
PATTERN: check-in-cadence
TAG: FILL:<distinctive-tag>
HABIT: FILL:<what habit>
QUESTION: FILL:<single question>
LOG_FILE: FILL:<absolute path, e.g. {{OWNER_HOME}}/Projects/biohacking/checkin-log.md>
ESCALATION: FILL:<rule for adjusting cadence or self-deleting>

Each check-in:
1. If LOG_FILE exists, read the last N entries to understand the trajectory.
2. Compose a check-in that:
   - References the recent trajectory briefly ("3 in a row this week" / "been a few days")
   - Asks the QUESTION directly
   - Fits base voice (short, specific, no em dashes)
3. Post via tg-post.
4. Do NOT wait for a reply here — the reply comes via Sam messaging the topic CC, which handles the follow-up separately (can be configured to append to LOG_FILE via a skill or manual CC action).
5. Apply ESCALATION rule:
   - If the rule says "self-delete after N yesses", count recent entries and delete if threshold met. Post farewell first.
   - If the rule says "cadence change", post "Switching to FILL:<new cadence> based on recent pattern" and then edit your own reminder via `PATCH /reminders/$MY_ID` with a new cron (after plan 009 ships message/cron PATCH support).
```

**Real-world example seeds:** daily meditation check-in, weekly therapy homework review, monthly financial reflection.

---

## Pattern: context-aware-one-shot

**When to use:** single-fire reminder where the MESSAGE content should be composed fresh at fire time based on current context (weather, calendar, recent activity), not pre-written at creation time. No self-delete needed because one-shots auto-delete after firing.

**Required inputs:**
- `TOPIC`: what the reminder is about
- `CONTEXT_SOURCES`: which context to gather (weather / calendar / status / memory)
- `OUTPUT_SHAPE`: what the final posted message should look like

**Template:**

```
PATTERN: context-aware-one-shot
TOPIC: FILL:<short topic>

Gather context:
- FILL:<context source 1, e.g. weather via scripts/weather.sh --for-reminder>
- FILL:<context source 2, e.g. today's calendar via gog calendar events --today>
- FILL:<context source 3, e.g. Projects/<slug>/STATUS.md>

Using that context, compose a message that:
- FILL:<specific shape — e.g. "mentions current temp, names the dogs, suggests clothing">
- Follows base voice rules (short, no em dashes, action-oriented)

Post via `bash {{OWNER_HOME}}/scripts/tg-post.sh {{TELEGRAM_CHAT_ID}} <thread_id> "<message>"`, then exit.

No self-delete needed — the gateway auto-deletes one-shot reminders after successful fire.
```

**Real-world example:** the Canton Fair one-shot I created at 3:22 PM today was SUPPOSED to be this pattern but was created as a `kind: 'text'` reminder instead (my mistake). Plan 009 migration will wrap all legacy text reminders with this pattern.

---

## Composing reminders that use these patterns

Three ways to apply a pattern:

**1. Manual `POST /reminders` (what I just did for Canton Fair):** copy the template into the `message` field, fill the `FILL:` slots, submit to the gateway.

**2. Via `/remind` skill natural language (post-plan-009):** say "nag me until the Canton Fair trip is booked" and the skill recognizes the pattern-matching phrase, looks up the `nag-until-done` template, asks you for the minimum fields it needs, and creates the reminder.

**3. Via a helper script** (optional future work): `scripts/create-reminder-from-pattern.py --pattern nag-until-done --tag canton-fair-acme --goal "..." --check-paths "..."` that knows the templates and does the expansion.

For now, manual is the primary path. The `/remind` skill integration lands with Unit 7 of plan 009.

## Adding a new pattern

1. Identify a pattern you've used ad-hoc twice — that's the trigger to formalize it. Don't generalize from a single use.
2. Add it to the table at the top of this file.
3. Add a full section below with Required inputs + Template + Real-world example (or example seeds if none exist yet).
4. If the pattern needs new tooling (e.g. a new context source, a new API call), add it to `reminder-agent-base.md`'s "Common context sources" so every reminder inherits it.
5. Commit with a `docs(prompts): add <pattern-name> reminder pattern` message.

## Rules

- **Patterns compose, they don't override.** Every reminder, regardless of pattern, inherits the base voice rules from `reminder-agent-base.md`. If a pattern template contradicts the base, the base wins.
- **Self-delete is gated by explicit stop conditions.** A pattern can tell the agent HOW to self-delete, but the user-prompt message must tell it WHEN. No silent auto-deletes on ambiguous state.
- **Always post a farewell before self-deleting.** Sam should see WHY a reminder went away, not just notice its absence later.
- **Distinctive tags are required for self-lookup.** The base prompt's self-delete contract relies on a `TAG` substring being uniquely present in the reminder's message body. Patterns that support self-delete must include a `TAG:` line in their template.
- **Patterns are prompts, not code.** These are instructions for the LLM agent running the reminder. They can be as expressive as natural language allows. If a pattern gets too complex to express in prose, it's a signal the reminder system needs new primitives — add them to the gateway, don't cram them into the prompt.
