## 2026-07-29 — the documents lane threw on the real vault (manifest outcome vocabulary)

`open/legacy-import/documents/manifest.ts` validated the projects-lane manifest against three outcomes — `created`, `existing`, `skipped-deleted` — and threw on anything else.

PR #475 taught the projects lane to import archived projects, adding `created-archived`, `existing-archived`, `skipped-active` and `skipped`. **#475 landed BEFORE the documents lane (#476), and this set was never widened.** So on any vault containing an archived project, the manifest read threw and the documents lane could not run at all. Ryan's vault has 19 archived projects — the lane was broken on his real data from the moment it merged.

**The throw itself is correct and stays.** An unrecognised outcome means the two lanes have drifted, and placing documents against a manifest we do not understand is worse than stopping. What was wrong was the vocabulary, not the strictness.

**Found by the tasks lane, not by us.** It needed the same parser, wrote the complete set from `run-import.ts`, and reported the mismatch. The cross-check existed only because two lanes read one file — nothing in the documents lane's own tests could have caught it, since they all construct their own manifests with the three outcomes it already knew.

Mutation-verified in both directions: reverting to the three-outcome set fails the new test; emptying the set fails 39 tests, proving the guard is still load-bearing rather than decorative. 45 pass / 0 fail.
