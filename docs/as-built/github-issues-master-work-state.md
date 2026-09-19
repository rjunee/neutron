## 2026-09-19 — GitHub Issues named as the work-state authority

### What changed

The repository entry point now says explicitly that GitHub Issues is the master
source for work state: open/done state, priority, blockers, and milestone
assignment. It retains the separate rule that `docs/spec-items/` owns normative
content and acceptance criteria.

### Why

The former short form called Issues only the "inbox". That was compatible with
the queue lifecycle but obscured the ownership table in
`docs/process/work-tracking.md`: GitHub Issues owns work state, while spec items
own normative content. The ambiguity allowed live build evidence to advance
without the shared issue picture being updated.

### Evidence

- `docs/process/work-tracking.md:35-41` assigns work state to GitHub Issues and
  normative content to spec items.
- `docs/process/work-tracking.md:85-102` keeps acceptance criteria in the repo
  and prohibits a second normative queue.
- The updated `AGENTS.md` states both halves together, so making Issues current
  cannot be mistaken for moving acceptance criteria into editable issue text.
