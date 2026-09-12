## 2026-09-12 — eleven orphaned as-built records, promoted to shards

The staging queue at `.trident/as-built/` held **eleven** entries, the oldest from
2026-08-18. They were orphaned by the design working exactly as documented: a
branch stages its record and the OUTER LOOP folds it after the merge lands
(`CONTRIBUTING.md` § "The as-built log has ONE writer"). The outer loop is
trident, and trident has not published since 2026-08-18 — so every record staged
by a hand-merged PR since then stayed in the queue, invisible in the log it was
written for.

That is the mechanism behind a number measured earlier today: 16 commits had
landed since the frozen log's newest entry and only one of them touched it. The
records were not missing. They were queued behind a process that had stopped
running, and nothing reported that.

Eight are historical trident work — the 90-minute hang watchdog killing live
builds, the fire-turn settle timeout being read as proof of death, the wrong-base
refusal's destructive remedy, the purity gate running on the build loop's own
branch, the local suite's scrubbed env, two web/mobile fixes, and, fittingly, the
2026-08-18 change that introduced the one-writer rule in the first place. Three
are today's: the work-tracking standard, the as-built freeze, and the root
`AGENTS.md` un-ban.

Promoted under the rule `docs/as-built/README.md` states rather than a nicer one:
the slug is the branch's own name where the change has no spec item. Several read
awkwardly (`3-main-s-local-suite-is-red-50-file`) because they are truncated
branch names, and renaming them to something tidier would have invented
provenance that does not exist. A record should say where it came from.

Nothing was edited on the way through. Each file's heading and body are
byte-identical to what its PR staged, which is the point of a record: it says
what was true when the change landed, not what reads well afterwards.

The staging directory is now empty and the promotion path it feeds is live
(`promoteInScratch`, `trident/as-built-appender.ts:161`). Until trident runs
again, promotion is a MANUAL step after each merge. That is worth writing down
because the failure mode is silent in both directions: the record lands in the
PR, CI passes, the queue grows, and the log simply never gains it — which is
precisely how eleven of them accumulated unnoticed.
