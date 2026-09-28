## 2026-09-28 — Retain receipt evidence without full command output

Registered rollout backfill retained entire command-completion records, including
output and invocation text that the importer never consumed. A valid large native
source could therefore exceed the retained-journal limit even though its actual
attribution evidence was small. The receipt projection now lives beside the native
importer and shares its command grammar. It retains only native identities, phase
boundaries, model context, exact per-turn usage and required PR evidence. Full
command output, test selectors, PR bodies and prompt/context text are discarded.
Malformed records retain compact markers; usage regression and unknown attribution
keep their existing semantics. Older bounded checkpoints are compacted on replay.
Wrong-type nested values in scalar receipt fields are normalized without retaining
their contents; failed or incomplete PR-create records retain no output URL.

The 1 GiB source, 128 MiB receipt journal, 8 MiB line and one-million-record limits
are unchanged. An oversized legacy checkpoint still refuses before projection.
No deployed journal, source registry or service is changed by this PR.

Focused tests compare projected and original importer observations and coverage
for accepted and refused command grammars, native token/model histories and malformed
records. A streamed synthetic source with more than 128 MiB of command output
produces a checkpoint below 100 KB, preserves native phase clocks and token counts
through the authenticated API, reads zero bytes on restart, and permits later exact
attribution without inventing ownership. Legacy checkpoint replay is covered.

Semantic mutation controls fail when projection retains raw private fields and
when it drops a required input-token field. The malformed-root regression was
observed failing before its correction and passing afterwards. Mutations were
restored. Shared-host and exact-head CI evidence remains a publication prerequisite.
