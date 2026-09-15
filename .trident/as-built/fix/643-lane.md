## 2026-09-14 — Refuse stale literal assertions in newly added prose

### What changed

The new guard enumerates simple literal `const` declarations removed and added
by a zero-context branch diff, pairs changed values by identifier, and checks
only added Markdown lines (`scripts/ci/stale-prose-guard.ts:24-80`). A line that
names the identifier and old literal without the new literal is refused; a
correction carrying both states is allowed (`scripts/ci/stale-prose-guard.ts:68-75`).
An unreadable diff exits 2 instead of becoming an empty result
(`scripts/ci/stale-prose-guard.ts:98-109`).

The already-required governed-repository entry point spawns the guard and
propagates its exit code (`scripts/ci/check-governed-repo-attributes.ts:161-184`).
That entry point is run by the unconditional `layering` job
(`.github/workflows/ci.yml:326-377`), so the check is continuously maintained by
required CI and does not depend on the author remembering it. The root guidance
states the check's narrow scope and retains the authored whole-tree search for
everything semantic (`AGENTS.md:78-85`). The acceptance contract records the
same exclusions (`docs/spec-items/a-changed-literal-must-not-leave-new-prose-stale.md:10-42`).

### Decisions and document disposition

Code is authoritative for the two literal-policy examples: the arbiter grant is
empty (`trident/arbiter.ts:124-166`), while the sink credential accepts every
mode with no group or other bits (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:404-420`).
Their as-built records retain superseded text as marked history rather than being
rewritten; existing records are immutable. The REPL plan likewise marks its old
criterion superseded immediately below it
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:137-149`). The tracked-file
absence rule was already corrected separately (`AGENTS.md:67-76` and
`docs/spec-items/absence-is-a-question-about-the-ref.md:12-31`).

I implemented the narrow changed-literal candidate because its false and healthy
cases are decidable from one diff. I did not build a general semantic checker, a
docblock checker, a removed-identifier checker, or a cross-document contradiction
checker; this instrument cannot establish those properties and does not claim to.
No feature flag or alternate path was introduced.

### Tests and mutations

The real-git tests cover stale added prose, unchanged prose, an explicit
old-to-new correction, an unreadable ref, and the CI invocation
(`scripts/ci/stale-prose-guard.test.ts:43-85`). Focused verification passed 80
tests across the new test, its CI host test, and the generated-index test. Lint
passed every repository check. A focused TypeScript compile of the two new files
passed with the repository's strict and unchecked-index settings.

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| stale old literal refusal (`scripts/ci/stale-prose-guard.ts:72`) | removed the condition's negation | stale-record test expected exit 1 and received 0 | 5/5 guard tests passed |
| required-job invocation (`scripts/ci/check-governed-repo-attributes.ts:184`) | commented out the call | wiring test expected one executable call and found none | 5/5 guard tests passed |

The first attempted wiring assertion counted a commented call and therefore
could not red. It was replaced with a start-to-end executable-line assertion
before the mutation was accepted (`scripts/ci/stale-prose-guard.test.ts:81-84`).
The first refusal mutation reddened before the new file was staged, but produced
no visible `git diff`; it was repeated against the staged baseline with the
landed line and one-line diff printed.

The full typecheck matrix remains red on base-tree lines outside this change:
`gateway/transcription/__tests__/whisper-install.test.ts:186`,
`logger/__tests__/fire-and-forget.test.ts:300-301`, and
`onboarding/history-import/__tests__/zip-writer.ts:10`. A path-limited diff
against `origin/main` printed the new guard as its positive control and none of
those three paths, establishing that this branch does not modify them. The same
root compile no longer reports either new guard file.

### Deliberately not changed

I did not edit frozen historical as-built shards, broaden the issue beyond its
named documentation-drift territory, change `SPEC.md`, or touch the three
unrelated base-tree type errors.
